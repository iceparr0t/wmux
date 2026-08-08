import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REVISION = /^[0-9a-f]{40}$/;
const SOURCE_ENTRY = "src/server/index.ts";

export interface WmuxRepositoryProvenance {
  revision: string;
  clean: boolean;
  source: "live-git" | "unavailable";
}

export interface WmuxRuntimeProvenance {
  runtime: "live-source" | "built-artifact" | "unavailable";
  startup: WmuxRepositoryProvenance;
  current: WmuxRepositoryProvenance;
}

interface BoundStartup {
  runtime: WmuxRuntimeProvenance["runtime"];
  repository: WmuxRepositoryProvenance;
  root?: string;
  entry?: string;
}

export interface WmuxRuntimeAttestor {
  current: () => Promise<WmuxRuntimeProvenance>;
}

const unavailable = (): WmuxRepositoryProvenance => ({
  revision: "unknown",
  clean: false,
  source: "unavailable",
});

const git = async (cwd: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 3_000,
  });
  return stdout.trim();
};

type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const sampleWmuxRepositoryProvenance = async (
  root: string,
  runGit: GitRunner = git,
): Promise<WmuxRepositoryProvenance> => {
  const revisionBefore = await runGit(root, ["rev-parse", "HEAD"]);
  if (!REVISION.test(revisionBefore)) return unavailable();
  const status = await runGit(root, ["status", "--porcelain", "--untracked-files=normal"]);
  const revisionAfter = await runGit(root, ["rev-parse", "HEAD"]);
  if (revisionAfter !== revisionBefore) return unavailable();
  return { revision: revisionBefore, clean: status.length === 0, source: "live-git" };
};

const canonicalRootFor = async (location: string): Promise<string> =>
  fs.realpath(await git(location, ["rev-parse", "--show-toplevel"]));

const bindStartup = async (entryUrl: string, cwd: string): Promise<BoundStartup> => {
  try {
    const entry = await fs.realpath(fileURLToPath(entryUrl));
    const canonicalCwd = await fs.realpath(cwd);
    const [entryRoot, cwdRoot] = await Promise.all([
      canonicalRootFor(path.dirname(entry)),
      canonicalRootFor(canonicalCwd),
    ]);
    if (entryRoot !== cwdRoot) return { runtime: "unavailable", repository: unavailable() };
    const relativeEntry = path.relative(entryRoot, entry).split(path.sep).join("/");
    const runtime = relativeEntry === SOURCE_ENTRY ? "live-source" : "built-artifact";
    if (runtime !== "live-source") {
      return { runtime, repository: unavailable() };
    }
    await git(entryRoot, ["ls-files", "--error-unmatch", "--", SOURCE_ENTRY]);
    return {
      runtime,
      repository: await sampleWmuxRepositoryProvenance(entryRoot),
      root: entryRoot,
      entry,
    };
  } catch {
    return { runtime: "unavailable", repository: unavailable() };
  }
};

export const createWmuxRuntimeAttestor = (
  entryUrl: string,
  cwdProvider: () => string = () => process.cwd(),
): WmuxRuntimeAttestor => {
  const startupPromise = bindStartup(entryUrl, cwdProvider());
  return {
    current: async () => {
      const startup = await startupPromise;
      if (!startup.root || !startup.entry || startup.runtime !== "live-source") {
        return { runtime: startup.runtime, startup: startup.repository, current: unavailable() };
      }
      try {
        const currentCwd = cwdProvider();
        const [entry, cwd, cwdRoot] = await Promise.all([
          fs.realpath(fileURLToPath(entryUrl)),
          fs.realpath(currentCwd),
          canonicalRootFor(currentCwd),
        ]);
        const cwdInsideRoot = cwd === startup.root || cwd.startsWith(`${startup.root}${path.sep}`);
        if (entry !== startup.entry || cwdRoot !== startup.root || !cwdInsideRoot) {
          return { runtime: "unavailable", startup: startup.repository, current: unavailable() };
        }
        await git(startup.root, ["ls-files", "--error-unmatch", "--", SOURCE_ENTRY]);
        return {
          runtime: startup.runtime,
          startup: startup.repository,
          current: await sampleWmuxRepositoryProvenance(startup.root),
        };
      } catch {
        return { runtime: "unavailable", startup: startup.repository, current: unavailable() };
      }
    },
  };
};

export const unavailableWmuxRuntimeAttestor = (): WmuxRuntimeAttestor => ({
  current: async () => ({ runtime: "unavailable", startup: unavailable(), current: unavailable() }),
});
