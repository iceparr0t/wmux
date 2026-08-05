#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fail = (message) => { throw new Error(message); };
const uid = process.getuid?.();
if (!Number.isInteger(uid)) fail("staging policy requires a POSIX uid");

const runnerImage = "mcr.microsoft.com/playwright@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a";
const runnerPlaywrightVersion = "1.61.0";
const runnerLogLimit = 4 * 1024 * 1024;

const exactKeys = (value, expected, name) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${name} keys differ from the staging allowlist`);
  }
};

const exactMembers = (actual, expected, name) => {
  if (!Array.isArray(actual)) fail(`${name} must be an array`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (left.length !== right.length || left.some((entry, index) => entry !== right[index])) fail(`${name} differs from policy`);
};

const exactMap = (actual, expected, name) => {
  exactKeys(actual, Object.keys(expected), name);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) fail(`${name} value drift for ${key}`);
  }
};

const requireEmptyList = (value, name) => {
  if (value !== null && (!Array.isArray(value) || value.length !== 0)) fail(`${name} must be empty`);
};

const requireOptionalStringList = (value, name) => {
  if (value !== null && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
    fail(`${name} must be null or a string array`);
  }
};

const requireOptionalStringMap = (value, name) => {
  if (value !== null && (!value || typeof value !== "object" || Array.isArray(value)
    || Object.values(value).some((entry) => typeof entry !== "string"))) {
    fail(`${name} must be null or a string map`);
  }
};

const safeValue = (value, name) => {
  if (!value || /[\r\n\0]/.test(value)) fail(`${name} is empty or contains control characters`);
  return value;
};

const pathParts = (absolutePath) => {
  const withoutTrailing = absolutePath === "/" ? absolutePath : absolutePath.replace(/\/+$/, "");
  const resolved = path.resolve(absolutePath);
  if (resolved !== withoutTrailing) fail(`path must be absolute and normalized: ${absolutePath}`);
  const parts = resolved.split(path.sep).filter(Boolean);
  const paths = [path.parse(resolved).root];
  for (const part of parts) paths.push(path.join(paths.at(-1), part));
  return paths;
};

const validateAncestor = (entryPath, isTarget = false) => {
  const stat = fs.lstatSync(entryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`unsafe non-directory or symlink path component: ${entryPath}`);
  if (stat.uid !== 0 && stat.uid !== uid) fail(`path component has an unexpected owner: ${entryPath}`);
  const mode = stat.mode & 0o7777;
  const stickyRootDirectory = stat.uid === 0 && (mode & 0o1000) !== 0;
  if ((mode & 0o002) !== 0 && !stickyRootDirectory) fail(`path component is world-writable: ${entryPath}`);
  if (isTarget && (stat.uid !== uid || (mode & 0o777) !== 0o700)) {
    fail(`private staging directory must be owned by uid ${uid} with mode 700: ${entryPath}`);
  }
};

const preparePrivateDirectory = (target) => {
  const parts = pathParts(target);
  let firstMissing = parts.length;
  for (let index = 0; index < parts.length; index += 1) {
    if (!fs.existsSync(parts[index])) { firstMissing = index; break; }
    validateAncestor(parts[index], index === parts.length - 1);
  }
  for (let index = firstMissing; index < parts.length; index += 1) {
    fs.mkdirSync(parts[index], { mode: 0o700 });
    validateAncestor(parts[index], true);
  }
  validateAncestor(parts.at(-1), true);
};

const validatePrivateDirectory = (target) => {
  const parts = pathParts(target);
  for (let index = 0; index < parts.length; index += 1) validateAncestor(parts[index], index === parts.length - 1);
};

const validateOwnerOnlyTree = (root) => {
  const visit = (entryPath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) fail(`isolated repository entry is not owner-only: ${entryPath}`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(entryPath)) visit(path.join(entryPath, name));
    } else if (!stat.isFile() || stat.isSymbolicLink()) fail(`isolated repository contains an unsupported entry: ${entryPath}`);
  };
  visit(root);
  if (fs.existsSync(path.join(root, "objects/info/alternates"))) fail("isolated repository must not use alternate objects");
  if (git(["--git-dir", root, "remote"]).trim()) fail("isolated repository must not retain remotes");
};

const validateEmptyDirectory = (target) => {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || ![0o500, 0o700].includes(stat.mode & 0o777)) {
    fail("Docker config must be an owner-only directory");
  }
  if (fs.readdirSync(target).length !== 0) fail("Docker config must start empty");
};

const validateDockerConfigPath = (lockDirectory, dockerConfig) => {
  const lockParts = pathParts(lockDirectory);
  if (!path.basename(lockDirectory).startsWith(".lock-wmux-staging-")) fail("Docker config lock path is not a staging lock");
  const lockStat = fs.lstatSync(lockDirectory);
  const owner = lockStat.uid;
  for (let index = 0; index < lockParts.length; index += 1) {
    const entryPath = lockParts[index];
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`unsafe Docker config path component: ${entryPath}`);
    if (stat.uid !== 0 && stat.uid !== owner) fail(`Docker config path component has an unexpected owner: ${entryPath}`);
    const mode = stat.mode & 0o7777;
    if ((mode & 0o002) !== 0 && !(stat.uid === 0 && (mode & 0o1000) !== 0)) {
      fail(`Docker config path component is world-writable: ${entryPath}`);
    }
  }
  if ((lockStat.mode & 0o777) !== 0o700) fail("Docker config lock must have mode 700");
  if (dockerConfig !== path.join(lockDirectory, "docker-config")) fail("Docker config must be the exact staging lock child");
  const configStat = fs.lstatSync(dockerConfig);
  if (!configStat.isDirectory() || configStat.isSymbolicLink() || (configStat.uid !== owner && configStat.uid !== 0)) {
    fail("Docker config must be a non-symlink directory owned by the staging user or root");
  }
  return owner;
};

const removeDockerConfigTree = (lockDirectory, dockerConfig) => {
  const owner = validateDockerConfigPath(lockDirectory, dockerConfig);
  const removeEntry = (entryPath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== owner && stat.uid !== 0) fail(`refusing Docker config entry with an unexpected owner: ${entryPath}`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(entryPath, 0o700);
      for (const name of fs.readdirSync(entryPath)) removeEntry(path.join(entryPath, name));
      fs.rmdirSync(entryPath);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      fs.unlinkSync(entryPath);
    } else {
      fail(`refusing unsupported Docker config entry: ${entryPath}`);
    }
  };
  removeEntry(dockerConfig);
};

const dockerConfigCleanupAuthority = (lockDirectory, dockerConfig) => {
  const owner = validateDockerConfigPath(lockDirectory, dockerConfig);
  const needsRoot = (entryPath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== owner && stat.uid !== 0) fail(`Docker config entry has an unexpected owner: ${entryPath}`);
    if (stat.uid === 0 && owner !== 0) return true;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return fs.readdirSync(entryPath).some((name) => needsRoot(path.join(entryPath, name)));
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) fail(`unsupported Docker config entry: ${entryPath}`);
    return false;
  };
  return needsRoot(dockerConfig) ? "sudo" : "direct";
};

const approvedWorktreeRoot = "/mnt/storage/sw_projects/.worktrees/wmux";

const validateWorktreeRoot = (target) => {
  if (path.resolve(target) !== approvedWorktreeRoot || target !== approvedWorktreeRoot) {
    fail(`staging worktrees must be direct children of ${approvedWorktreeRoot}`);
  }
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o002) !== 0) {
    fail("approved staging worktree root is unsafe");
  }
};

const removePrivateTree = (target) => {
  validatePrivateDirectory(target);
  const removeEntry = (entryPath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== uid) fail(`refusing to remove entry with an unexpected owner: ${entryPath}`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(entryPath, 0o700);
      for (const entry of fs.readdirSync(entryPath)) removeEntry(path.join(entryPath, entry));
      fs.rmdirSync(entryPath);
    } else if (stat.isFile() || stat.isSymbolicLink()) {
      fs.unlinkSync(entryPath);
    } else {
      fail(`refusing to remove unsupported entry: ${entryPath}`);
    }
  };
  removeEntry(target);
};

const gitEnvironment = () => ({
  PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: process.env.HOME ?? "/nonexistent",
  LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
});

const git = (args, options = {}) => {
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.file.allow=never", ...args,
  ], {
    encoding: options.encoding ?? "utf8",
    env: gitEnvironment(),
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) fail(`isolated Git command failed: ${args[0] ?? ""}`);
  return result.stdout;
};

const parseTreeOutput = (output) => {
  const entries = new Map();
  for (const record of output.subarray(0, output.length - (output.at(-1) === 0 ? 1 : 0)).toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (!match) fail("git ls-tree returned malformed output");
    const [, mode, type, object, relative] = match;
    if (relative === ".git" || relative.startsWith(".git/")) fail("commit tree contains reserved .git material");
    if (mode === "160000" || type === "commit") fail(`unsupported gitlink in candidate tree: ${relative}`);
    if (!["100644", "100755", "120000"].includes(mode) || type !== "blob") {
      fail(`unsupported tree entry ${mode} ${type}: ${relative}`);
    }
    entries.set(relative, { mode, object });
  }
  return entries;
};

const parseTree = (repository, revision) => parseTreeOutput(
  git(["--git-dir", repository, "ls-tree", "-rz", "--full-tree", revision], { encoding: "buffer" }),
);

const hashBlobNoFilters = (bytes) => git(["hash-object", "--no-filters", "--stdin"], { input: bytes }).trim();

const committedTreeDigest = (entries) => {
  const hash = crypto.createHash("sha256");
  const add = (value) => {
    const bytes = Buffer.from(value);
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length); hash.update(bytes);
  };
  for (const [relative, entry] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    add(relative); add(entry.mode); add(entry.object);
  }
  return hash.digest("hex");
};

const validateSourceCheckout = (root, revision) => {
  const expected = parseTreeOutput(git(["-C", root, "ls-tree", "-rz", "--full-tree", revision], { encoding: "buffer" }));
  const indexOutput = git(["-C", root, "ls-files", "--stage", "-z"], { encoding: "buffer" });
  const index = new Map();
  for (const record of indexOutput.subarray(0, indexOutput.length - (indexOutput.at(-1) === 0 ? 1 : 0)).toString("utf8").split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== "0") fail("source index contains an unsupported staged entry");
    index.set(match[4], { mode: match[1], object: match[2] });
  }
  if (index.size !== expected.size) fail("staged checkout changes detected");
  for (const [relative, entry] of expected) {
    const staged = index.get(relative);
    if (!staged || staged.mode !== entry.mode || staged.object !== entry.object) fail("staged checkout changes detected");
    const absolute = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { fail("tracked checkout changes detected"); }
    let bytes;
    if (entry.mode === "120000") {
      if (!stat.isSymbolicLink()) fail("tracked checkout changes detected");
      bytes = Buffer.from(fs.readlinkSync(absolute));
    } else {
      if (!stat.isFile() || stat.isSymbolicLink() || ((stat.mode & 0o111) !== 0) !== (entry.mode === "100755")) {
        fail("tracked checkout changes detected");
      }
      bytes = fs.readFileSync(absolute);
    }
    if (hashBlobNoFilters(bytes) !== entry.object) fail("tracked checkout changes detected");
  }
};

const validateCommittedTree = (repository, root, revision, {
  allowNodeModules = false, ignoreRootGit = false, strictOwnerModes = false, name: treeName = "committed tree",
} = {}) => {
  validatePrivateDirectory(root);
  const expected = parseTree(repository, revision);
  const expectedDirectories = new Set();
  for (const relative of expected.keys()) {
    let parent = path.posix.dirname(relative);
    while (parent !== ".") { expectedDirectories.add(parent); parent = path.posix.dirname(parent); }
  }
  const actual = new Set();
  const resolvedRoot = path.resolve(root);
  const nodeModulesRoot = path.join(resolvedRoot, "node_modules");
  let nodeModulesEntries = 0;
  const validateNodeModulesEntry = (entryPath) => {
    nodeModulesEntries += 1;
    if (nodeModulesEntries > 250_000) fail("candidate node_modules entry count exceeds policy");
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== uid || (!stat.isSymbolicLink() && (stat.mode & 0o077) !== 0)) {
      fail(`candidate node_modules entry is not owner-only: ${path.relative(nodeModulesRoot, entryPath)}`);
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(entryPath)) validateNodeModulesEntry(path.join(entryPath, name));
    } else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(entryPath);
      if (path.isAbsolute(target)) fail("candidate node_modules contains an absolute symlink");
      const resolvedTarget = path.resolve(path.dirname(entryPath), target);
      if (resolvedTarget !== nodeModulesRoot && !resolvedTarget.startsWith(`${nodeModulesRoot}${path.sep}`)) {
        fail("candidate node_modules symlink escapes its dependency tree");
      }
    } else if (!stat.isFile()) fail("candidate node_modules contains an unsupported file type");
  };
  const visit = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (!relative && name === ".git" && ignoreRootGit) continue;
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = path.join(directory, name);
      if (!relative && name === "node_modules" && allowNodeModules) {
        const stat = fs.lstatSync(child);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("candidate node_modules root is unsafe");
        validateNodeModulesEntry(child);
        continue;
      }
      const stat = fs.lstatSync(child);
      if (stat.uid !== uid || (!stat.isSymbolicLink() && (stat.mode & 0o077) !== 0)) {
        fail(`${treeName} entry is not owner-only: ${childRelative}`);
      }
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (strictOwnerModes && (stat.mode & 0o777) !== 0o700) fail(`${treeName} directory mode drift: ${childRelative}`);
        if (!expectedDirectories.has(childRelative)) fail(`${treeName} contains an untracked directory: ${childRelative}`);
        visit(child, childRelative);
      }
      else actual.add(childRelative);
    }
  };
  visit(root);
  if (actual.size !== expected.size || [...actual].some((entry) => !expected.has(entry))) {
    fail(`${treeName} paths differ from the commit tree`);
  }
  for (const [relative, entry] of expected) {
    if (!actual.has(relative)) fail(`${treeName} is missing ${relative}`);
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    let bytes;
    if (entry.mode === "120000") {
      if (!stat.isSymbolicLink()) fail(`${treeName} symlink mode drift: ${relative}`);
      const target = fs.readlinkSync(absolute);
      if (path.isAbsolute(target)) fail(`${treeName} symlink is absolute: ${relative}`);
      const resolvedTarget = path.resolve(path.dirname(absolute), target);
      if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
        fail(`${treeName} symlink escapes its root: ${relative}`);
      }
      bytes = Buffer.from(target);
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`${treeName} file type drift: ${relative}`);
      const executable = (stat.mode & 0o111) !== 0;
      if (executable !== (entry.mode === "100755")) fail(`${treeName} executable mode drift: ${relative}`);
      const expectedMode = entry.mode === "100755" ? 0o700 : 0o600;
      if (strictOwnerModes && (stat.mode & 0o777) !== expectedMode) fail(`${treeName} owner mode drift: ${relative}`);
      bytes = fs.readFileSync(absolute);
    }
    if (hashBlobNoFilters(bytes) !== entry.object) fail(`${treeName} blob drift: ${relative}`);
  }
  return expected;
};

const validateWorktree = (repository, root, revision, { allowNodeModules = false } = {}) => {
  validatePrivateDirectory(repository);
  validateWorktreeRoot(path.dirname(root));
  return validateCommittedTree(repository, root, revision, {
    allowNodeModules, ignoreRootGit: true, name: "candidate worktree",
  });
};

const validatePlaywrightExecutable = (root) => {
  const executable = path.join(root, "node_modules/.bin/playwright");
  const resolvedExecutable = fs.realpathSync(executable);
  const nodeModulesRoot = `${path.resolve(root, "node_modules")}${path.sep}`;
  if (!resolvedExecutable.startsWith(nodeModulesRoot)) fail("candidate Playwright executable escapes node_modules");
  const stat = fs.lstatSync(resolvedExecutable);
  if (!stat.isFile() || stat.uid !== uid || (stat.mode & 0o111) === 0 || (stat.mode & 0o077) !== 0) {
    fail("candidate Playwright executable is unsafe");
  }
};

const validateE2eWorktree = (repository, root, revision) => {
  validateWorktree(repository, root, revision, { allowNodeModules: true });
  validatePlaywrightExecutable(root);
};

const validateDependencyWorktree = (repository, root, revision) => {
  if (!fs.existsSync(path.join(root, "node_modules"))) fail("candidate node_modules is missing");
  validateWorktree(repository, root, revision, { allowNodeModules: true });
};

const dependencyTreeDigest = (root) => {
  const dependencyRoot = path.join(root, "node_modules");
  const hash = crypto.createHash("sha256");
  const add = (value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length); hash.update(bytes);
  };
  const visit = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      const child = path.join(directory, name);
      const stat = fs.lstatSync(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        add(`d:${stat.mode & 0o777}:${childRelative}`); visit(child, childRelative);
      } else if (stat.isSymbolicLink()) {
        add(`l:${childRelative}`); add(fs.readlinkSync(child));
      } else {
        add(`f:${stat.mode & 0o777}:${childRelative}`); add(fs.readFileSync(child));
      }
    }
  };
  visit(dependencyRoot);
  return hash.digest("hex");
};

const dependencyDigest = (repository, root, revision) => {
  validateE2eWorktree(repository, root, revision);
  return dependencyTreeDigest(root);
};

const copyCommittedTree = (repository, source, destination, revision, treeName) => {
  const expected = validateCommittedTree(repository, source, revision, {
    strictOwnerModes: true, name: `${treeName} source`,
  });
  if (fs.existsSync(destination)) fail(`${treeName} destination is not exclusive`);
  fs.mkdirSync(destination, { mode: 0o700 });
  const directories = new Set();
  for (const relative of expected.keys()) {
    let parent = path.posix.dirname(relative);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  for (const relative of [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right);
  })) fs.mkdirSync(path.join(destination, relative), { mode: 0o700 });
  for (const [relative, entry] of expected) {
    const sourcePath = path.join(source, relative);
    const destinationPath = path.join(destination, relative);
    if (entry.mode === "120000") {
      const target = fs.readlinkSync(sourcePath);
      const resolvedTarget = path.resolve(path.dirname(destinationPath), target);
      if (path.isAbsolute(target) || (resolvedTarget !== destination && !resolvedTarget.startsWith(`${destination}${path.sep}`))) {
        fail(`${treeName} symlink escapes its root: ${relative}`);
      }
      fs.symlinkSync(target, destinationPath);
      continue;
    }
    const sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let destinationDescriptor;
    try {
      const sourceStat = fs.fstatSync(sourceDescriptor);
      const bytes = fs.readFileSync(sourceDescriptor);
      if (!sourceStat.isFile() || hashBlobNoFilters(bytes) !== entry.object) fail(`${treeName} source changed while copying: ${relative}`);
      destinationDescriptor = fs.openSync(destinationPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        entry.mode === "100755" ? 0o700 : 0o600);
      fs.writeFileSync(destinationDescriptor, bytes); fs.fsyncSync(destinationDescriptor);
    } finally {
      if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
      fs.closeSync(sourceDescriptor);
    }
  }
  return expected;
};

const e2eContextKeys = [
  "WMUX_E2E_CONTEXT", "WMUX_BUILD_REVISION", "WMUX_BUILD_TREE_DIGEST", "WMUX_E2E_CONTEXT_DEV", "WMUX_E2E_CONTEXT_INO",
];

const createE2eContext = (buildIdentityFile, repository, destination, identityFile) => {
  const build = validateBuildContextIdentity(buildIdentityFile, repository);
  const runtimeDirectory = path.dirname(buildIdentityFile);
  if (destination !== path.join(runtimeDirectory, "e2e-context") || identityFile !== path.join(runtimeDirectory, "e2e-context.env")) {
    fail("E2E context paths must use their dedicated runtime locations");
  }
  if (fs.existsSync(identityFile)) fail("E2E context identity is not exclusive");
  try {
    const expected = copyCommittedTree(repository, build.WMUX_BUILD_CONTEXT, destination, build.WMUX_BUILD_REVISION, "E2E context");
    const stat = fs.lstatSync(destination);
    const values = {
      WMUX_E2E_CONTEXT: destination,
      WMUX_BUILD_REVISION: build.WMUX_BUILD_REVISION,
      WMUX_BUILD_TREE_DIGEST: committedTreeDigest(expected),
      WMUX_E2E_CONTEXT_DEV: String(stat.dev), WMUX_E2E_CONTEXT_INO: String(stat.ino),
    };
    writeExclusive(identityFile, `${e2eContextKeys.map((key) => `${key}=${values[key]}`).join("\n")}\n`);
  } catch (error) {
    if (fs.existsSync(destination)) removePrivateTree(destination);
    throw error;
  }
};

const validateE2eContextIdentity = (identityFile, repository, allowNodeModules) => {
  const values = readMetadata(identityFile);
  exactKeys(values, e2eContextKeys, "E2E context identity");
  const runtimeDirectory = path.dirname(identityFile);
  if (identityFile !== path.join(runtimeDirectory, "e2e-context.env")
    || values.WMUX_E2E_CONTEXT !== path.join(runtimeDirectory, "e2e-context")) fail("E2E context identity path drift");
  const stat = fs.lstatSync(values.WMUX_E2E_CONTEXT);
  if (String(stat.dev) !== values.WMUX_E2E_CONTEXT_DEV || String(stat.ino) !== values.WMUX_E2E_CONTEXT_INO) {
    fail("E2E context filesystem identity changed");
  }
  const expected = validateCommittedTree(repository, values.WMUX_E2E_CONTEXT, values.WMUX_BUILD_REVISION, {
    allowNodeModules, strictOwnerModes: true, name: "E2E context",
  });
  if (committedTreeDigest(expected) !== values.WMUX_BUILD_TREE_DIGEST) fail("E2E context source digest drift");
  return values;
};

const validatePlaywrightVersion = (root) => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  for (const packageName of ["@playwright/test", "playwright", "playwright-core"]) {
    const lockVersion = lock.packages?.[`node_modules/${packageName}`]?.version;
    const installed = JSON.parse(fs.readFileSync(path.join(root, `node_modules/${packageName}/package.json`), "utf8")).version;
    if (lockVersion !== runnerPlaywrightVersion || installed !== runnerPlaywrightVersion) {
      fail(`Playwright package/image version drift for ${packageName}`);
    }
  }
};

const e2eDependencyKeys = [...e2eContextKeys, "WMUX_E2E_DEPENDENCY_DIGEST", "WMUX_PLAYWRIGHT_VERSION"];

const sealE2eContext = (contextIdentityFile, dependencyIdentityFile, repository) => {
  const values = validateE2eContextIdentity(contextIdentityFile, repository, true);
  if (dependencyIdentityFile !== path.join(path.dirname(contextIdentityFile), "e2e-dependencies.env")) fail("E2E dependency identity path drift");
  validatePlaywrightVersion(values.WMUX_E2E_CONTEXT);
  validatePlaywrightExecutable(values.WMUX_E2E_CONTEXT);
  const digest = dependencyTreeDigest(values.WMUX_E2E_CONTEXT);
  const sealed = { ...values, WMUX_E2E_DEPENDENCY_DIGEST: digest, WMUX_PLAYWRIGHT_VERSION: runnerPlaywrightVersion };
  writeExclusive(dependencyIdentityFile, `${e2eDependencyKeys.map((key) => `${key}=${sealed[key]}`).join("\n")}\n`);
};

const validateSealedE2eContext = (dependencyIdentityFile, contextIdentityFile, repository) => {
  const sealed = readMetadata(dependencyIdentityFile);
  exactKeys(sealed, e2eDependencyKeys, "E2E dependency identity");
  const current = validateE2eContextIdentity(contextIdentityFile, repository, true);
  for (const key of e2eContextKeys) if (sealed[key] !== current[key]) fail(`sealed E2E context drift for ${key}`);
  if (sealed.WMUX_PLAYWRIGHT_VERSION !== runnerPlaywrightVersion) fail("sealed Playwright version drift");
  validatePlaywrightVersion(current.WMUX_E2E_CONTEXT);
  validatePlaywrightExecutable(current.WMUX_E2E_CONTEXT);
  const digest = dependencyTreeDigest(current.WMUX_E2E_CONTEXT);
  if (digest !== sealed.WMUX_E2E_DEPENDENCY_DIGEST) fail("E2E dependency tree digest drift");
  return sealed;
};

const secureWorktree = (root) => {
  validateWorktreeRoot(path.dirname(root));
  const visit = (entryPath) => {
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== uid) fail(`worktree entry has an unexpected owner: ${entryPath}`);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      fs.chmodSync(entryPath, 0o700);
      for (const name of fs.readdirSync(entryPath)) visit(path.join(entryPath, name));
    } else if (stat.isFile()) {
      fs.chmodSync(entryPath, (stat.mode & 0o111) !== 0 ? 0o700 : 0o600);
    } else if (!stat.isSymbolicLink()) fail(`unsupported worktree entry: ${entryPath}`);
  };
  visit(root);
};

const validateDockerfile = (filePath) => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) fail("candidate Dockerfile is unsafe");
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  let escape = "\\";
  for (const line of lines) {
    if (!line.trim()) continue;
    const directive = /^\s*#\s*escape\s*=\s*([`\\])\s*$/i.exec(line);
    if (directive) { escape = directive[1]; continue; }
    if (/^\s*#/.test(line)) continue;
    break;
  }
  const effectiveInstruction = (instruction) => {
    let current = instruction;
    for (let depth = 0; depth < 16; depth += 1) {
      const match = /^\s*([A-Za-z]+)\b([\s\S]*)$/.exec(current);
      if (!match) return undefined;
      if (match[1].toUpperCase() !== "ONBUILD") return { name: match[1].toUpperCase(), body: match[2] };
      current = match[2];
    }
    fail("Dockerfile ONBUILD nesting exceeds policy");
  };
  const logical = [];
  for (let index = 0; index < lines.length; index += 1) {
    let current = lines[index];
    while (new RegExp(`${escape === "\\" ? "\\\\" : "`"}\\s*$`).test(lines[index]) && index + 1 < lines.length) {
      index += 1;
      current += `\n${lines[index]}`;
    }
    if (effectiveInstruction(current)?.name === "RUN") {
      const delimiters = [...current.matchAll(/<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/g)].map((match) => match[2]);
      for (const delimiter of delimiters) {
        let found = false;
        while (index + 1 < lines.length) {
          index += 1;
          current += `\n${lines[index]}`;
          if (lines[index].replace(/^\t+/, "") === delimiter) { found = true; break; }
        }
        if (!found) fail(`unterminated Dockerfile RUN heredoc: ${delimiter}`);
      }
    }
    logical.push(current);
  }
  for (const instruction of logical) {
    const effective = effectiveInstruction(instruction);
    if (effective?.name === "RUN" && /(^|[\s"'[,])--mount(?=$|[\s=,"'\]])/i.test(effective.body)) {
      fail("candidate Dockerfile RUN uses a forbidden --mount option");
    }
  }
};

const writeExclusive = (filePath, content) => {
  validatePrivateDirectory(path.dirname(filePath));
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  let descriptor;
  let createdIdentity;
  try {
    descriptor = fs.openSync(filePath, flags, 0o600);
    const created = fs.fstatSync(descriptor);
    createdIdentity = { dev: created.dev, ino: created.ino };
    fs.writeFileSync(descriptor, content, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
    fs.fsyncSync(directory);
    fs.closeSync(directory);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (createdIdentity) {
      try {
        const current = fs.lstatSync(filePath);
        if (current.dev === createdIdentity.dev && current.ino === createdIdentity.ino) fs.unlinkSync(filePath);
      } catch {}
    }
    throw error;
  }
};

const buildContextIdentityKeys = [
  "WMUX_BUILD_CONTEXT", "WMUX_BUILD_REVISION", "WMUX_BUILD_TREE_DIGEST",
  "WMUX_BUILD_CONTEXT_DEV", "WMUX_BUILD_CONTEXT_INO",
];

const createBuildContext = (repository, source, destination, revision, identityFile) => {
  if (!/^[0-9a-f]{40,64}$/.test(revision ?? "")) fail("invalid build-context revision");
  validatePrivateDirectory(repository);
  const expected = validateWorktree(repository, source, revision);
  const runtimeDirectory = path.dirname(destination);
  validatePrivateDirectory(runtimeDirectory);
  if (destination !== path.join(runtimeDirectory, "build-context")
    || identityFile !== path.join(runtimeDirectory, "build-context.env")) {
    fail("build-context paths must use their dedicated runtime locations");
  }
  if (fs.existsSync(destination) || fs.existsSync(identityFile)) fail("build-context destination is not exclusive");

  let created = false;
  try {
    fs.mkdirSync(destination, { mode: 0o700 });
    created = true;
    const directories = new Set();
    for (const relative of expected.keys()) {
      let parent = path.posix.dirname(relative);
      while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
    }
    for (const relative of [...directories].sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth || left.localeCompare(right);
    })) {
      fs.mkdirSync(path.join(destination, relative), { mode: 0o700 });
    }

    for (const [relative, entry] of expected) {
      const sourcePath = path.join(source, relative);
      const destinationPath = path.join(destination, relative);
      if (entry.mode === "120000") {
        const target = fs.readlinkSync(sourcePath);
        if (path.isAbsolute(target)) fail(`candidate symlink is absolute: ${relative}`);
        const resolvedTarget = path.resolve(path.dirname(destinationPath), target);
        if (resolvedTarget !== destination && !resolvedTarget.startsWith(`${destination}${path.sep}`)) {
          fail(`candidate symlink escapes the build context: ${relative}`);
        }
        fs.symlinkSync(target, destinationPath);
        continue;
      }

      const sourceFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      const sourceDescriptor = fs.openSync(sourcePath, sourceFlags);
      let destinationDescriptor;
      try {
        const sourceStat = fs.fstatSync(sourceDescriptor);
        if (!sourceStat.isFile() || sourceStat.uid !== uid
          || ((sourceStat.mode & 0o111) !== 0) !== (entry.mode === "100755")) {
          fail(`candidate file changed while materializing: ${relative}`);
        }
        const bytes = fs.readFileSync(sourceDescriptor);
        if (hashBlobNoFilters(bytes) !== entry.object) fail(`candidate blob changed while materializing: ${relative}`);
        const destinationFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW ?? 0);
        destinationDescriptor = fs.openSync(destinationPath, destinationFlags, entry.mode === "100755" ? 0o700 : 0o600);
        fs.writeFileSync(destinationDescriptor, bytes);
        fs.fsyncSync(destinationDescriptor);
      } finally {
        if (destinationDescriptor !== undefined) fs.closeSync(destinationDescriptor);
        fs.closeSync(sourceDescriptor);
      }
    }

    const actual = validateCommittedTree(repository, destination, revision, {
      strictOwnerModes: true, name: "local build context",
    });
    const stat = fs.lstatSync(destination);
    const values = {
      WMUX_BUILD_CONTEXT: destination,
      WMUX_BUILD_REVISION: revision,
      WMUX_BUILD_TREE_DIGEST: committedTreeDigest(actual),
      WMUX_BUILD_CONTEXT_DEV: String(stat.dev),
      WMUX_BUILD_CONTEXT_INO: String(stat.ino),
    };
    writeExclusive(identityFile, `${buildContextIdentityKeys.map((key) => `${key}=${safeValue(values[key], key)}`).join("\n")}\n`);
  } catch (error) {
    if (created && fs.existsSync(destination)) removePrivateTree(destination);
    throw error;
  }
};

const validateBuildContextIdentity = (identityFile, repository) => {
  const values = readMetadata(identityFile);
  exactKeys(values, buildContextIdentityKeys, "build-context identity");
  const runtimeDirectory = path.dirname(identityFile);
  if (identityFile !== path.join(runtimeDirectory, "build-context.env")
    || values.WMUX_BUILD_CONTEXT !== path.join(runtimeDirectory, "build-context")) {
    fail("build-context identity path drift");
  }
  if (!/^[0-9a-f]{40,64}$/.test(values.WMUX_BUILD_REVISION ?? "")
    || !/^[0-9a-f]{64}$/.test(values.WMUX_BUILD_TREE_DIGEST ?? "")) {
    fail("invalid build-context object identity");
  }
  validatePrivateDirectory(repository);
  const stat = fs.lstatSync(values.WMUX_BUILD_CONTEXT);
  if (String(stat.dev) !== values.WMUX_BUILD_CONTEXT_DEV || String(stat.ino) !== values.WMUX_BUILD_CONTEXT_INO) {
    fail("build-context filesystem identity changed");
  }
  const expected = validateCommittedTree(repository, values.WMUX_BUILD_CONTEXT, values.WMUX_BUILD_REVISION, {
    strictOwnerModes: true, name: "local build context",
  });
  if (committedTreeDigest(expected) !== values.WMUX_BUILD_TREE_DIGEST) fail("build-context tree digest drift");
  return values;
};

const emitBuildContextIdentity = (identityFile, repository) => {
  const values = validateBuildContextIdentity(identityFile, repository);
  process.stdout.write(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
};

const createMetadata = (filePath, values) => {
  const keys = [
    "COMPOSE_PROJECT_NAME", "WMUX_IMAGE", "WMUX_BUILD_VERSION", "WMUX_BUILD_REVISION",
    "WMUX_BUILD_CONTEXT", "WMUX_BUILD_CONTEXT_IDENTITY", "WMUX_BUILD_TREE_DIGEST",
    "WMUX_IDENTITY_PATH",
    "WMUX_PUBLISH_HOST", "WMUX_PUBLISH_PORT", "WMUX_PUBLIC_URL",
    "WMUX_DOCKER_MODE", "WMUX_DOCKER_CONTEXT", "WMUX_DOCKER_ENDPOINT", "WMUX_DOCKER_ENGINE_ID",
  ];
  if (values.length !== keys.length) fail("invalid staging metadata field count");
  const lines = keys.map((key, index) => `${key}=${safeValue(values[index], key)}`);
  const sharedToken = crypto.randomBytes(32).toString("hex");
  let registrationToken = crypto.randomBytes(32).toString("hex");
  while (registrationToken === sharedToken) registrationToken = crypto.randomBytes(32).toString("hex");
  lines.push(`WMUX_TOKEN=${sharedToken}`, `WMUX_REGISTRATION_TOKEN=${registrationToken}`);
  writeExclusive(filePath, `${lines.join("\n")}\n`);
};

const createIdentity = (filePath, [repository, worktree, revision, scriptBlob]) => {
  if (!/^[0-9a-f]{40,64}$/.test(revision ?? "") || !/^[0-9a-f]{40,64}$/.test(scriptBlob ?? "")) fail("invalid candidate object identity");
  validatePrivateDirectory(repository);
  validateOwnerOnlyTree(repository);
  validateWorktree(repository, worktree, revision);
  const gitFile = path.join(worktree, ".git");
  const repositoryStat = fs.lstatSync(repository);
  const worktreeStat = fs.lstatSync(worktree);
  const gitFileStat = fs.lstatSync(gitFile);
  if (!gitFileStat.isFile() || gitFileStat.isSymbolicLink() || gitFileStat.uid !== uid) fail("worktree Git file is unsafe");
  const gitDirLine = fs.readFileSync(gitFile, "utf8").trim();
  const gitDir = gitDirLine.startsWith("gitdir: ") ? path.resolve(worktree, gitDirLine.slice(8)) : "";
  const expectedPrefix = `${path.resolve(repository)}${path.sep}worktrees${path.sep}`;
  if (!gitDir.startsWith(expectedPrefix)) fail("worktree Git directory is outside the isolated repository");
  const gitDirStat = fs.lstatSync(gitDir);
  const values = {
    WMUX_ISOLATED_REPOSITORY: repository, WMUX_WORKTREE: worktree, WMUX_WORKTREE_GIT_DIR: gitDir,
    WMUX_BUILD_REVISION: revision, WMUX_SCRIPT_BLOB: scriptBlob,
    WMUX_REPOSITORY_DEV: String(repositoryStat.dev), WMUX_REPOSITORY_INO: String(repositoryStat.ino),
    WMUX_WORKTREE_DEV: String(worktreeStat.dev), WMUX_WORKTREE_INO: String(worktreeStat.ino),
    WMUX_WORKTREE_GIT_DIR_DEV: String(gitDirStat.dev), WMUX_WORKTREE_GIT_DIR_INO: String(gitDirStat.ino),
  };
  writeExclusive(filePath, `${Object.entries(values).map(([key, value]) => `${key}=${safeValue(value, key)}`).join("\n")}\n`);
};

const readMetadata = (filePath) => {
  validateMetadata(filePath);
  const result = {};
  for (const line of fs.readFileSync(filePath, "utf8").trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) fail("malformed staging metadata");
    const key = line.slice(0, separator);
    if (Object.hasOwn(result, key)) fail(`duplicate staging metadata key: ${key}`);
    result[key] = line.slice(separator + 1);
  }
  return result;
};

const validateIdentity = (filePath) => {
  const values = readMetadata(filePath);
  const keys = ["WMUX_ISOLATED_REPOSITORY", "WMUX_WORKTREE", "WMUX_WORKTREE_GIT_DIR", "WMUX_BUILD_REVISION", "WMUX_SCRIPT_BLOB", "WMUX_REPOSITORY_DEV", "WMUX_REPOSITORY_INO", "WMUX_WORKTREE_DEV", "WMUX_WORKTREE_INO", "WMUX_WORKTREE_GIT_DIR_DEV", "WMUX_WORKTREE_GIT_DIR_INO"];
  exactKeys(values, keys, "staging identity");
  const identities = [
    [values.WMUX_ISOLATED_REPOSITORY, values.WMUX_REPOSITORY_DEV, values.WMUX_REPOSITORY_INO],
    [values.WMUX_WORKTREE, values.WMUX_WORKTREE_DEV, values.WMUX_WORKTREE_INO],
    [values.WMUX_WORKTREE_GIT_DIR, values.WMUX_WORKTREE_GIT_DIR_DEV, values.WMUX_WORKTREE_GIT_DIR_INO],
  ];
  for (const [entryPath, dev, ino] of identities) {
    const stat = fs.lstatSync(entryPath);
    if (stat.uid !== uid || String(stat.dev) !== dev || String(stat.ino) !== ino) fail(`staging identity changed: ${entryPath}`);
  }
  validatePrivateDirectory(values.WMUX_ISOLATED_REPOSITORY);
  validateOwnerOnlyTree(values.WMUX_ISOLATED_REPOSITORY);
  validateWorktreeRoot(path.dirname(values.WMUX_WORKTREE));
  const gitDirPrefix = `${path.resolve(values.WMUX_ISOLATED_REPOSITORY)}${path.sep}worktrees${path.sep}`;
  if (!path.resolve(values.WMUX_WORKTREE_GIT_DIR).startsWith(gitDirPrefix)) fail("recorded worktree Git directory escaped the isolated repository");
  return values;
};

const emitIdentity = (filePath) => {
  const values = validateIdentity(filePath);
  process.stdout.write(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
};

const validateCleanupWorktree = (repository, worktree, revision) => {
  validateWorktree(repository, worktree, revision, { allowNodeModules: fs.existsSync(path.join(worktree, "node_modules")) });
};

const removeRegisteredWorktree = (repository, worktree) => {
  const listBefore = git(["--git-dir", repository, "worktree", "list", "--porcelain"]);
  if (!listBefore.split("\n").some((line) => line === `worktree ${worktree}`)) fail("isolated Git does not record the candidate worktree");
  git(["--git-dir", repository, "worktree", "remove", "--force", worktree]);
  if (fs.existsSync(worktree)) fail("recorded worktree remains after isolated Git cleanup");
  const listAfter = git(["--git-dir", repository, "worktree", "list", "--porcelain"]);
  if (listAfter.split("\n").some((line) => line === `worktree ${worktree}`)) fail("isolated Git still records removed worktree");
};

const removeAuditedStage = (identityFile, runtimeDirectory) => {
  const values = validateIdentity(identityFile);
  if (path.dirname(identityFile) !== runtimeDirectory || path.dirname(values.WMUX_ISOLATED_REPOSITORY) !== runtimeDirectory) {
    fail("cleanup runtime path differs from recorded identity");
  }
  validateCleanupWorktree(values.WMUX_ISOLATED_REPOSITORY, values.WMUX_WORKTREE, values.WMUX_BUILD_REVISION);
  removeRegisteredWorktree(values.WMUX_ISOLATED_REPOSITORY, values.WMUX_WORKTREE);
  removePrivateTree(runtimeDirectory);
};

const createLiveMetadata = (filePath, values) => {
  const keys = [
    "WMUX_CONTAINER_ID", "WMUX_NETWORK_ID", "WMUX_IMAGE_ID", "WMUX_CONTAINER_NAME", "WMUX_NETWORK_NAME",
    "WMUX_LIVE_DOCKER_MODE", "WMUX_LIVE_DOCKER_CONTEXT", "WMUX_LIVE_DOCKER_ENDPOINT", "WMUX_LIVE_DOCKER_ENGINE_ID",
  ];
  if (values.length !== keys.length) fail("invalid live metadata field count");
  const lines = keys.map((key, index) => `${key}=${safeValue(values[index], key)}`);
  writeExclusive(filePath, `${lines.join("\n")}\n`);
};

const createProvisionMetadata = (filePath, [repository, worktree, revision]) => {
  if (!/^[0-9a-f]{40,64}$/.test(revision ?? "")) fail("invalid provision revision");
  writeExclusive(filePath, `WMUX_ISOLATED_REPOSITORY=${safeValue(repository, "repository")}\nWMUX_WORKTREE=${safeValue(worktree, "worktree")}\nWMUX_BUILD_REVISION=${revision}\n`);
};

const validateProvision = (filePath) => {
  const values = readMetadata(filePath);
  exactKeys(values, ["WMUX_ISOLATED_REPOSITORY", "WMUX_WORKTREE", "WMUX_BUILD_REVISION"], "staging provision");
  if (!/^[0-9a-f]{40,64}$/.test(values.WMUX_BUILD_REVISION ?? "")) fail("invalid provision revision");
  const runtimeDirectory = path.dirname(filePath);
  if (values.WMUX_ISOLATED_REPOSITORY !== path.join(runtimeDirectory, "repository.git")) fail("provision repository path drift");
  validateWorktreeRoot(path.dirname(values.WMUX_WORKTREE));
  validatePrivateDirectory(values.WMUX_ISOLATED_REPOSITORY);
  validateOwnerOnlyTree(values.WMUX_ISOLATED_REPOSITORY);
  validateCleanupWorktree(values.WMUX_ISOLATED_REPOSITORY, values.WMUX_WORKTREE, values.WMUX_BUILD_REVISION);
  return values;
};

const emitProvision = (filePath) => {
  const values = validateProvision(filePath);
  process.stdout.write(`${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`);
};

const removeAuditedProvision = (provisionFile, runtimeDirectory) => {
  if (path.dirname(provisionFile) !== runtimeDirectory) fail("cleanup runtime path differs from provision metadata");
  const values = validateProvision(provisionFile);
  removeRegisteredWorktree(values.WMUX_ISOLATED_REPOSITORY, values.WMUX_WORKTREE);
  removePrivateTree(runtimeDirectory);
};

const validateMetadata = (filePath) => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    fail("staging metadata must be an owner-only regular file with mode 600");
  }
};

const parseStdinJson = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const expectedBuildArgs = (revision, version) => ({
  ALL_PROXY: "", FTP_PROXY: "", HTTPS_PROXY: "", HTTP_PROXY: "", NO_PROXY: "",
  WMUX_REVISION: revision, WMUX_VERSION: version,
  all_proxy: "", ftp_proxy: "", http_proxy: "", https_proxy: "", no_proxy: "",
});

const expectedEnvironment = (host, publicUrl, token, registrationToken) => ({
  WMUX_BROWSER_AUTH_MODE: "shared-or-login",
  WMUX_HOST: "",
  WMUX_PORT: "3478",
  WMUX_PUBLIC_URL: publicUrl,
  WMUX_PUBLISH_HOST: host,
  WMUX_REGISTRATION_TOKEN: registrationToken,
  WMUX_TOKEN: token,
});

const composeTmpfs = {
  "/home/node/.wmux": ["rw", "nosuid", "nodev", "mode=0700", "size=256m", "uid=1000", "gid=1000"],
  "/tmp": ["rw", "nosuid", "nodev", "noexec", "mode=1777", "size=64m", "uid=1000", "gid=1000"],
  "/run": ["rw", "nosuid", "nodev", "noexec", "mode=0755", "size=8m", "uid=1000", "gid=1000"],
};

const validateCompose = async ([project, context, host, port, image, revision, version, publicUrl, metadataFile]) => {
  const metadata = readMetadata(metadataFile);
  const token = metadata.WMUX_TOKEN;
  const registrationToken = metadata.WMUX_REGISTRATION_TOKEN;
  if (!/^[0-9a-f]{64}$/.test(token ?? "") || !/^[0-9a-f]{64}$/.test(registrationToken ?? "") || token === registrationToken) {
    fail("staging secrets must be distinct 64-hex values");
  }
  const config = await parseStdinJson();
  exactKeys(config, ["name", "networks", "services"], "Compose root");
  if (config.name !== project) fail("Compose project name drift");
  exactKeys(config.services, ["wmux"], "Compose services");
  exactKeys(config.networks, ["default"], "Compose networks");
  const service = config.services.wmux;
  if (service.pid !== undefined && service.pid !== "") fail("Compose PID mode must be omitted or empty");
  const { pid: _pid, ...serviceWithoutPid } = service;
  exactKeys(serviceWithoutPid, [
    "build", "cap_drop", "command", "container_name", "cpus", "entrypoint", "environment", "image", "init", "ipc",
    "logging", "mem_limit", "memswap_limit", "networks", "pids_limit", "ports", "read_only", "restart",
    "security_opt", "tmpfs", "user",
  ], "Compose service");
  if (service.command !== null || service.entrypoint !== null) fail("Compose command/entrypoint drift");
  if (service.container_name !== `${project}-wmux` || service.image !== image || service.init !== true || service.user !== "node") {
    fail("Compose service identity drift");
  }
  if (service.privileged === true || service.read_only !== true || service.restart !== "no"
    || service.ipc !== "private") fail("Compose namespace/lifecycle drift");
  if (service.cpus !== 2 || service.pids_limit !== 512 || Number(service.mem_limit) !== 1_073_741_824
    || Number(service.memswap_limit) !== 1_073_741_824) fail("Compose resource limit drift");
  exactMembers(service.cap_drop, ["ALL"], "Compose cap_drop");
  exactMembers(service.security_opt, ["no-new-privileges:true"], "Compose security_opt");
  exactKeys(service.build, ["args", "context", "dockerfile"], "Compose build");
  if (path.resolve(service.build.context) !== context || service.build.dockerfile !== "deploy/docker/Dockerfile") fail("Compose build source drift");
  exactMap(service.build.args, expectedBuildArgs(revision, version), "Compose build args");
  exactMap(service.environment, expectedEnvironment(host, publicUrl, token, registrationToken), "Compose environment");
  exactKeys(service.networks, ["default"], "Compose service networks");
  const ports = service.ports;
  if (!Array.isArray(ports) || ports.length !== 1) fail("Compose port count drift");
  exactKeys(ports[0], ["host_ip", "mode", "protocol", "published", "target"], "Compose port");
  if (ports[0].host_ip !== host || String(ports[0].published) !== port || ports[0].target !== 3478
    || ports[0].protocol !== "tcp" || ports[0].mode !== "ingress") fail("Compose published port drift");
  exactKeys(service.logging, ["driver", "options"], "Compose logging");
  exactKeys(service.logging.options, ["max-file", "max-size"], "Compose logging options");
  if (service.logging.driver !== "local" || service.logging.options["max-file"] !== "3"
    || service.logging.options["max-size"] !== "10m") fail("Compose logging drift");
  if (!Array.isArray(service.tmpfs) || service.tmpfs.length !== 3) fail("Compose tmpfs count drift");
  for (const [destination, expected] of Object.entries(composeTmpfs)) {
    const entry = service.tmpfs.find((candidate) => candidate.startsWith(`${destination}:`));
    if (!entry) fail(`Compose tmpfs missing ${destination}`);
    exactMembers(entry.slice(destination.length + 1).split(","), expected, `Compose tmpfs ${destination}`);
  }
  // Compose normalizes explicit false network flags by omitting them; either true value remains an extra rejected key.
  exactKeys(config.networks.default, ["driver", "ipam", "name"], "Compose network");
  exactKeys(config.networks.default.ipam, [], "Compose network IPAM");
  if (config.networks.default.name !== `${project}_default` || config.networks.default.driver !== "bridge") fail("Compose network drift");
};

const liveTmpfs = {
  "/home/node/.wmux": { flags: ["rw", "nosuid", "nodev"], mode: 0o700, size: 268_435_456, uid: 1000, gid: 1000 },
  "/tmp": { flags: ["rw", "nosuid", "nodev", "noexec"], mode: 0o1777, size: 67_108_864, uid: 1000, gid: 1000 },
  "/run": { flags: ["rw", "nosuid", "nodev", "noexec"], mode: 0o755, size: 8_388_608, uid: 1000, gid: 1000 },
};

const parseSize = (value) => {
  const match = /^(\d+)([kmgt])?$/i.exec(value);
  if (!match) fail(`invalid tmpfs size: ${value}`);
  const multipliers = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Number(match[1]) * multipliers[(match[2] ?? "").toLowerCase()];
};

const validateTmpfsOptions = (actualValue, expected, destination) => {
  const fields = String(actualValue).split(",");
  const flags = [];
  const values = {};
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator === -1) flags.push(field);
    else values[field.slice(0, separator)] = field.slice(separator + 1);
  }
  exactMembers(flags, expected.flags, `live tmpfs flags ${destination}`);
  exactKeys(values, ["gid", "mode", "size", "uid"], `live tmpfs values ${destination}`);
  if (Number.parseInt(values.mode, 8) !== expected.mode || parseSize(values.size) !== expected.size
    || Number(values.uid) !== expected.uid || Number(values.gid) !== expected.gid) fail(`live tmpfs values drift for ${destination}`);
};

const validateContainer = async ([project, host, port, image, revision, containerId, networkId, imageId]) => {
  const value = await parseStdinJson();
  if (value.Id !== containerId || value.Image !== imageId || value.Name !== `/${project}-wmux`) fail("live container ID/name drift");
  exactKeys(value.Config, ["Image", "Labels", "User"], "live Config");
  if (value.Config.Image !== image || value.Config.User !== "node") fail("live image/user drift");
  const labels = value.Config.Labels;
  if (labels["com.docker.compose.project"] !== project || labels["com.docker.compose.service"] !== "wmux"
    || labels["org.opencontainers.image.revision"] !== revision) fail("live container labels drift");
  const h = value.HostConfig;
  exactKeys(h, [
    "Binds", "CapDrop", "DeviceRequests", "Devices", "IpcMode", "LogConfig", "Memory", "MemorySwap", "NanoCpus", "NetworkMode",
    "PidMode", "PidsLimit", "PortBindings", "Privileged", "ReadonlyRootfs", "RestartPolicy", "SecurityOpt", "Tmpfs",
    "VolumesFrom",
  ], "live HostConfig");
  if (h.Privileged !== false || h.ReadonlyRootfs !== true || h.PidMode !== "" || h.IpcMode !== "private"
    || h.NetworkMode !== `${project}_default` || h.PidsLimit !== 512 || h.NanoCpus !== 2_000_000_000
    || h.Memory !== 1_073_741_824 || h.MemorySwap !== 1_073_741_824 || h.RestartPolicy?.Name !== "no") {
    fail("live namespace/resource policy drift");
  }
  exactMembers(h.CapDrop, ["ALL"], "live CapDrop");
  exactMembers(h.SecurityOpt, ["no-new-privileges:true"], "live SecurityOpt");
  requireEmptyList(h.Devices, "live Devices");
  requireEmptyList(h.DeviceRequests, "live DeviceRequests");
  requireEmptyList(h.Binds, "live Binds");
  requireEmptyList(h.VolumesFrom, "live VolumesFrom");
  exactKeys(h.PortBindings, ["3478/tcp"], "live PortBindings");
  if (!Array.isArray(h.PortBindings["3478/tcp"]) || h.PortBindings["3478/tcp"].length !== 1
    || h.PortBindings["3478/tcp"][0].HostIp !== host || h.PortBindings["3478/tcp"][0].HostPort !== port) {
    fail("live PortBindings drift");
  }
  exactKeys(h.LogConfig, ["Config", "Type"], "live LogConfig");
  exactKeys(h.LogConfig.Config, ["max-file", "max-size"], "live LogConfig options");
  if (h.LogConfig.Type !== "local" || h.LogConfig.Config["max-file"] !== "3" || h.LogConfig.Config["max-size"] !== "10m") {
    fail("live logging drift");
  }
  exactKeys(h.Tmpfs, Object.keys(liveTmpfs), "live Tmpfs");
  for (const [destination, expected] of Object.entries(liveTmpfs)) validateTmpfsOptions(h.Tmpfs[destination], expected, destination);
  exactMembers(value.Mounts, [], "live Mounts");
  exactKeys(value.NetworkSettings, ["Networks", "Ports"], "live NetworkSettings");
  exactKeys(value.NetworkSettings.Networks, [`${project}_default`], "live attached networks");
  if (value.NetworkSettings.Networks[`${project}_default`].NetworkID !== networkId) fail("live attached network ID drift");
  exactKeys(value.NetworkSettings.Ports, ["3478/tcp"], "live realized ports");
  if (!Array.isArray(value.NetworkSettings.Ports["3478/tcp"]) || value.NetworkSettings.Ports["3478/tcp"].length !== 1
    || value.NetworkSettings.Ports["3478/tcp"][0].HostIp !== host
    || value.NetworkSettings.Ports["3478/tcp"][0].HostPort !== port) fail("live realized port drift");
};

const validateNetwork = async ([project, networkId]) => {
  const value = await parseStdinJson();
  exactKeys(value, ["Attachable", "Driver", "Id", "Internal", "Labels", "Name", "Options"], "live network inspect");
  if (value.Id !== networkId || value.Name !== `${project}_default` || value.Driver !== "bridge"
    || value.Internal !== false || value.Attachable !== false) {
    fail("live network identity drift");
  }
  exactKeys(value.Options, [], "live network options");
  if (value.Labels["com.docker.compose.project"] !== project || value.Labels["com.docker.compose.network"] !== "default") {
    fail("live network labels drift");
  }
};

const validateImage = async ([imageId, revision]) => {
  const value = await parseStdinJson();
  exactKeys(value, ["Id", "Labels"], "live image inspect");
  if (value.Id !== imageId || value.Labels?.["org.opencontainers.image.revision"] !== revision) {
    fail("live image identity/revision drift");
  }
};

const readJsonFile = (filePath, name) => {
  validateMetadata(filePath);
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { fail(`${name} is not valid JSON`); }
};

const validateRunnerImage = async () => {
  const value = await parseStdinJson();
  exactKeys(value, ["Id", "RepoDigests", "Config"], "runner image inspect");
  if (!/^sha256:[0-9a-f]{64}$/.test(value.Id ?? "")) fail("runner image ID is invalid");
  if (!Array.isArray(value.RepoDigests) || !value.RepoDigests.includes(runnerImage)) fail("runner image digest drift");
  exactKeys(value.Config, ["Cmd", "Entrypoint", "Env", "Labels"], "runner image Config");
  requireOptionalStringList(value.Config.Cmd, "runner image command");
  requireOptionalStringList(value.Config.Entrypoint, "runner image entrypoint");
  requireOptionalStringMap(value.Config.Labels, "runner image labels");
  if (!Array.isArray(value.Config.Env) || value.Config.Env.some((entry) => typeof entry !== "string"
    || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(entry))) {
    fail("runner base image environment is unsafe");
  }
};

const runnerTmpfs = (runnerUid, runnerGid) => ({
  "/home/wmux": { flags: ["rw", "nosuid", "nodev", "noexec"], mode: 0o700, size: 134_217_728, uid: runnerUid, gid: runnerGid },
  "/tmp": { flags: ["rw", "nosuid", "nodev", "noexec"], mode: 0o1777, size: 536_870_912, uid: runnerUid, gid: runnerGid },
  "/run": { flags: ["rw", "nosuid", "nodev", "noexec"], mode: 0o755, size: 8_388_608, uid: runnerUid, gid: runnerGid },
});

const validateRunnerContainer = async ([project, revision, runnerName, containerId, networkName, networkId, imageId,
  context, bootstrap, baseUrl, runnerUser, imageInspectFile]) => {
  if (!/^\d+:\d+$/.test(runnerUser ?? "")) fail("runner user must be numeric uid:gid");
  const [runnerUid, runnerGid] = runnerUser.split(":").map(Number);
  const imageInspect = readJsonFile(imageInspectFile, "runner image identity");
  const value = await parseStdinJson();
  exactKeys(value, ["Id", "Image", "Name", "Config", "HostConfig", "NetworkSettings", "Mounts"], "runner inspect");
  if (value.Id !== containerId || value.Image !== imageId || value.Name !== `/${runnerName}`) fail("runner container identity drift");
  const config = value.Config;
  exactKeys(config, ["Cmd", "Entrypoint", "Env", "Image", "Labels", "User", "WorkingDir"], "runner Config");
  if (config.Image !== runnerImage || config.User !== runnerUser || config.WorkingDir !== "/workspace") fail("runner image/user/workdir drift");
  exactMembers(config.Entrypoint, ["/runner-bootstrap"], "runner entrypoint");
  exactMembers(config.Cmd, ["run"], "runner command");
  exactMap(config.Labels, {
    ...(imageInspect.Config.Labels ?? {}),
    "org.opencontainers.image.revision": revision,
    "wmux.staging.e2e": "true",
    "wmux.staging.project": project,
  }, "runner labels");
  const requiredEnvironment = [
    `HOME=/home/wmux`, `TMPDIR=/tmp`, `XDG_CACHE_HOME=/home/wmux/.cache`,
    `WMUX_BUILD_REVISION=${revision}`, `WMUX_E2E_BASE_URL=${baseUrl}`,
  ];
  const inherited = imageInspect.Config?.Env;
  if (!Array.isArray(inherited)) fail("runner image environment identity is malformed");
  const expectedEnvironment = new Map(inherited.map((entry) => [String(entry).split("=", 1)[0], entry]));
  for (const entry of requiredEnvironment) expectedEnvironment.set(entry.split("=", 1)[0], entry);
  exactMembers(config.Env, [...expectedEnvironment.values()], "runner environment");
  if (config.Env.some((entry) => /(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIAL)=/i.test(entry))) fail("credential found in runner environment");

  const h = value.HostConfig;
  exactKeys(h, [
    "Binds", "CapDrop", "DeviceRequests", "Devices", "IpcMode", "Init", "LogConfig", "Memory", "MemorySwap", "Mounts",
    "NanoCpus", "NetworkMode", "PidMode", "PidsLimit", "PortBindings", "Privileged", "ReadonlyRootfs", "RestartPolicy",
    "SecurityOpt", "ShmSize", "Tmpfs", "UsernsMode", "VolumesFrom",
  ], "runner HostConfig");
  if (h.Privileged !== false || h.ReadonlyRootfs !== true || h.PidMode !== "" || h.IpcMode !== "private"
    || h.NetworkMode !== networkName || h.PidsLimit !== 512 || h.NanoCpus !== 2_000_000_000
    || h.Memory !== 2_147_483_648 || h.MemorySwap !== 2_147_483_648 || h.ShmSize !== 536_870_912
    || h.RestartPolicy?.Name !== "no" || h.UsernsMode !== "" || h.Init !== true) fail("runner namespace/resource policy drift");
  exactMembers(h.CapDrop, ["ALL"], "runner CapDrop");
  exactMembers(h.SecurityOpt, ["no-new-privileges:true"], "runner SecurityOpt");
  requireEmptyList(h.Binds, "runner Binds"); requireEmptyList(h.Devices, "runner Devices");
  requireEmptyList(h.DeviceRequests, "runner DeviceRequests"); requireEmptyList(h.VolumesFrom, "runner VolumesFrom");
  if (h.PortBindings !== null && Object.keys(h.PortBindings).length !== 0) fail("runner ports must be empty");
  exactKeys(h.LogConfig, ["Config", "Type"], "runner LogConfig");
  exactMap(h.LogConfig.Config, { "max-file": "1", "max-size": "4m" }, "runner LogConfig options");
  if (h.LogConfig.Type !== "local") fail("runner log driver drift");
  exactKeys(h.Tmpfs, Object.keys(runnerTmpfs(runnerUid, runnerGid)), "runner Tmpfs");
  for (const [destination, expected] of Object.entries(runnerTmpfs(runnerUid, runnerGid))) validateTmpfsOptions(h.Tmpfs[destination], expected, destination);
  if (!Array.isArray(h.Mounts) || h.Mounts.length !== 2 || h.Mounts.some((mount) => mount.Type !== "bind" || mount.ReadOnly !== true)) {
    fail("runner host mount policy drift");
  }
  const expectedMounts = new Map([[context, "/workspace"], [bootstrap, "/runner-bootstrap"]]);
  for (const mount of h.Mounts) if (expectedMounts.get(mount.Source) !== mount.Target) fail("runner host mount substitution detected");
  exactMembers(value.Mounts.map((mount) => `${mount.Type}:${mount.Source}:${mount.Destination}:${mount.RW}:${mount.Propagation}`), [
    `bind:${context}:/workspace:false:rprivate`, `bind:${bootstrap}:/runner-bootstrap:false:rprivate`,
  ], "runner realized mounts");
  exactKeys(value.NetworkSettings, ["Networks", "Ports"], "runner NetworkSettings");
  exactKeys(value.NetworkSettings.Networks, [networkName], "runner attached networks");
  if (value.NetworkSettings.Networks[networkName].NetworkID !== networkId) fail("runner network ID drift");
  if (value.NetworkSettings.Ports !== null && Object.keys(value.NetworkSettings.Ports).length !== 0) fail("runner realized ports must be empty");
};

const dockerInvocation = (mode, dockerConfig, selector, endpoint, dockerArgs) => {
  if (!['direct', 'sudo'].includes(mode) || !['context', 'host'].includes(selector)) fail("invalid runner Docker selector");
  validateDockerConfigPath(path.dirname(dockerConfig), dockerConfig);
  const selection = selector === "host" ? ["--host", endpoint] : ["--context", endpoint];
  const cleanEnvironment = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/nonexistent", LC_ALL: "C", LANG: "C", DOCKER_CONFIG: dockerConfig,
  };
  if (mode === "direct") return { command: "docker", args: [...selection, ...dockerArgs], env: cleanEnvironment };
  return {
    command: "sudo",
    args: ["-n", "env", "-i", `PATH=${cleanEnvironment.PATH}`, "HOME=/root", "LC_ALL=C", "LANG=C",
      `DOCKER_CONFIG=${dockerConfig}`, "docker", ...selection, ...dockerArgs],
    env: { PATH: cleanEnvironment.PATH, HOME: cleanEnvironment.HOME },
  };
};

const containsCredential = (bytes, token, registrationToken) => bytes.includes(Buffer.from(token)) || bytes.includes(Buffer.from(registrationToken));

const runRunner = (metadataFile, logFile, timeoutText, mode, dockerConfig, selector, endpoint, runnerName) => {
  const metadata = readMetadata(metadataFile);
  const token = metadata.WMUX_TOKEN; const registrationToken = metadata.WMUX_REGISTRATION_TOKEN;
  if (!/^[0-9a-f]{64}$/.test(token ?? "") || !/^[0-9a-f]{64}$/.test(registrationToken ?? "") || token === registrationToken) fail("runner credential metadata is invalid");
  const timeout = Number(timeoutText);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) fail("runner timeout is invalid");
  if (logFile !== path.join(path.dirname(metadataFile), "e2e-run.log")) fail("runner log path drift");
  if (fs.existsSync(logFile)) { validateMetadata(logFile); fs.unlinkSync(logFile); }
  const invocation = dockerInvocation(mode, dockerConfig, selector, endpoint, ["start", "-a", "-i", runnerName]);
  const result = spawnSync(invocation.command, invocation.args, {
    env: invocation.env, input: `${token}\n${registrationToken}\n`, timeout: timeout * 1000,
    maxBuffer: runnerLogLimit,
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.alloc(0);
  if (containsCredential(stdout, token, registrationToken) || containsCredential(stderr, token, registrationToken)) {
    try { fs.unlinkSync(logFile); } catch {}
    fail("credential material detected in runner output; output quarantined");
  }
  const combined = Buffer.concat([stdout, stderr]);
  writeExclusive(logFile, combined.subarray(0, runnerLogLimit));
  if (result.error?.code === "ETIMEDOUT") fail("runner exceeded its bounded timeout");
  if (result.error) fail("runner output exceeded its bounded capture or Docker start failed");
  if (result.status !== 0) fail(`runner exited with status ${result.status ?? "unknown"}`);
};

const scanRunnerResults = (metadataFile, mode, dockerConfig, selector, endpoint, runnerName) => {
  const metadata = readMetadata(metadataFile);
  const invocation = dockerInvocation(mode, dockerConfig, selector, endpoint, ["cp", `${runnerName}:/tmp/e2e-results/.`, "-"]);
  const result = spawnSync(invocation.command, invocation.args, { env: invocation.env, timeout: 60_000, maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail("runner results could not be scanned");
  if (containsCredential(result.stdout ?? Buffer.alloc(0), metadata.WMUX_TOKEN, metadata.WMUX_REGISTRATION_TOKEN)
    || containsCredential(result.stderr ?? Buffer.alloc(0), metadata.WMUX_TOKEN, metadata.WMUX_REGISTRATION_TOKEN)) {
    fail("credential material detected in runner results; results quarantined");
  }
};

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "prepare-private-dir": preparePrivateDirectory(args[0]); break;
    case "validate-worktree-root": validateWorktreeRoot(args[0]); break;
    case "validate-private-dir": validatePrivateDirectory(args[0]); break;
    case "validate-empty-dir": validateEmptyDirectory(args[0]); break;
    case "validate-docker-config-path": validateDockerConfigPath(...args); break;
    case "docker-config-cleanup-authority": process.stdout.write(`${dockerConfigCleanupAuthority(...args)}\n`); break;
    case "remove-docker-config-tree": removeDockerConfigTree(...args); break;
    case "remove-private-tree": removePrivateTree(args[0]); break;
    case "validate-worktree": validateWorktree(...args); break;
    case "validate-e2e-worktree": validateE2eWorktree(...args); break;
    case "validate-dependency-worktree": validateDependencyWorktree(...args); break;
    case "dependency-digest": process.stdout.write(`${dependencyDigest(...args)}\n`); break;
    case "runner-image": process.stdout.write(`${runnerImage}\n`); break;
    case "runner-playwright-version": process.stdout.write(`${runnerPlaywrightVersion}\n`); break;
    case "validate-source-checkout": validateSourceCheckout(...args); break;
    case "secure-worktree": secureWorktree(args[0]); break;
    case "create-build-context": createBuildContext(...args); break;
    case "validate-build-context": emitBuildContextIdentity(...args); break;
    case "create-e2e-context": createE2eContext(...args); break;
    case "seal-e2e-context": sealE2eContext(...args); break;
    case "validate-e2e-context": validateSealedE2eContext(...args); break;
    case "new-run-id": process.stdout.write(`${crypto.randomBytes(8).toString("hex")}\n`); break;
    case "validate-dockerfile": validateDockerfile(args[0]); break;
    case "create-metadata": createMetadata(args[0], args.slice(1)); break;
    case "create-identity": createIdentity(args[0], args.slice(1)); break;
    case "validate-identity": emitIdentity(args[0]); break;
    case "remove-audited-stage": removeAuditedStage(...args); break;
    case "create-live-metadata": createLiveMetadata(args[0], args.slice(1)); break;
    case "create-provision-metadata": createProvisionMetadata(args[0], args.slice(1)); break;
    case "validate-provision": emitProvision(args[0]); break;
    case "remove-audited-provision": removeAuditedProvision(...args); break;
    case "validate-metadata": validateMetadata(args[0]); break;
    case "validate-compose": await validateCompose(args); break;
    case "validate-container": await validateContainer(args); break;
    case "validate-network": await validateNetwork(args); break;
    case "validate-image": await validateImage(args); break;
    case "validate-runner-image": await validateRunnerImage(args); break;
    case "validate-runner-container": await validateRunnerContainer(args); break;
    case "run-runner": runRunner(...args); break;
    case "scan-runner-results": scanRunnerResults(...args); break;
    default: fail(`unknown staging policy command: ${command ?? ""}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
