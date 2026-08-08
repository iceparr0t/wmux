import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  createWmuxRuntimeAttestor,
  sampleWmuxRepositoryProvenance,
} from "../src/server/repository-provenance.js";

const createRepository = (parent: string, name: string, entry = "src/server/index.ts", tracked = true): {
  directory: string;
  entry: string;
  revision: string;
} => {
  const directory = path.join(parent, name);
  fs.mkdirSync(path.dirname(path.join(directory, entry)), { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "wmux test"], { cwd: directory });
  fs.writeFileSync(path.join(directory, entry), "export {};\n");
  fs.writeFileSync(path.join(directory, "tracked.txt"), "clean\n");
  execFileSync("git", ["add", "tracked.txt", ...(tracked ? [entry] : [])], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
  return {
    directory,
    entry: path.join(directory, entry),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim(),
  };
};

test("runtime attestor binds source entry, startup, current state, and nested cwd to one canonical Git root", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provenance-bound-"));
  try {
    const repository = createRepository(parent, "source");
    const nested = path.join(repository.directory, "nested");
    fs.mkdirSync(nested);
    const attestor = createWmuxRuntimeAttestor(pathToFileURL(repository.entry).href, () => nested);
    const exact = { revision: repository.revision, clean: true, source: "live-git" };
    assert.deepEqual(await attestor.current(), { runtime: "live-source", startup: exact, current: exact });
    fs.writeFileSync(path.join(repository.directory, "untracked.txt"), "dirty\n");
    assert.deepEqual(await attestor.current(), {
      runtime: "live-source",
      startup: exact,
      current: { ...exact, clean: false },
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("runtime attestor rejects mixed roots, cwd drift, built entries, and untracked source-shaped entries", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-provenance-reject-"));
  try {
    const source = createRepository(parent, "source");
    const other = createRepository(parent, "other");
    const unavailable = { revision: "unknown", clean: false, source: "unavailable" };
    assert.deepEqual(
      await createWmuxRuntimeAttestor(pathToFileURL(source.entry).href, () => other.directory).current(),
      { runtime: "unavailable", startup: unavailable, current: unavailable },
    );

    let cwd = source.directory;
    const drifting = createWmuxRuntimeAttestor(pathToFileURL(source.entry).href, () => cwd);
    assert.equal((await drifting.current()).runtime, "live-source");
    cwd = other.directory;
    assert.deepEqual((await drifting.current()).current, unavailable);

    const built = createRepository(parent, "built", "dist/server/index.js");
    assert.deepEqual(
      await createWmuxRuntimeAttestor(pathToFileURL(built.entry).href, () => built.directory).current(),
      { runtime: "built-artifact", startup: unavailable, current: unavailable },
    );

    const untracked = createRepository(parent, "untracked", "src/server/index.ts", false);
    assert.deepEqual(
      await createWmuxRuntimeAttestor(pathToFileURL(untracked.entry).href, () => untracked.directory).current(),
      { runtime: "unavailable", startup: unavailable, current: unavailable },
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("repository provenance rejects a HEAD change during cleanliness sampling", async () => {
  const revisions = ["a".repeat(40), "b".repeat(40)];
  assert.deepEqual(await sampleWmuxRepositoryProvenance("/fixture", async (_cwd, args) => {
    if (args[0] === "status") return "";
    return revisions.shift()!;
  }), {
    revision: "unknown",
    clean: false,
    source: "unavailable",
  });
});
