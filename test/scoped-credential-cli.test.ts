import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(import.meta.dirname, "..");
const checker = path.join(repoRoot, "scripts", "wmux-check-scoped-credentials");

const writeMetadata = (directory: string, expiresAt: number) => {
  const metadataPath = path.join(directory, "scoped-credentials.json");
  fs.writeFileSync(metadataPath, JSON.stringify({
    schemaVersion: 1,
    credentials: {
      helper: {
        tokenDigest: "a".repeat(64),
        issuedAt: Date.now() - 1_000,
        expiresAt,
      },
    },
  }), { mode: 0o600 });
  fs.chmodSync(metadataPath, 0o600);
  return metadataPath;
};

test("scoped credential checker reports bounded non-secret expiry metadata", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-scoped-check-"));
  try {
    const metadataPath = writeMetadata(directory, Date.now() + 60_000);
    let result: { stdout: string };
    try {
      result = await execFile(process.execPath, [checker, "--json", "--metadata-path", metadataPath, "--warn-before", "120", "--fail-before", "10"]);
      assert.fail("expected warning exit status");
    } catch (error: any) {
      assert.equal(error.code, 1);
      result = error;
    }
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(report.status, "warning");
    assert.equal(JSON.stringify(report).includes("a".repeat(64)), false);
    assert.deepEqual(report.credentials && (report.credentials as Array<Record<string, unknown>>).map(({ kind, status }) => ({ kind, status })), [
      { kind: "helper", status: "warning" },
    ]);
    await assert.rejects(
      execFile(process.execPath, [checker, "--metadata-path", metadataPath, "--warn-before", "120", "--fail-before", "120"]),
      (error: any) => error.code === 2,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("scoped credential checker is read-only and rejects unsafe metadata", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-scoped-check-"));
  try {
    const metadataPath = writeMetadata(directory, Date.now() + 10_000_000);
    const before = fs.readFileSync(metadataPath, "utf8");
    fs.chmodSync(metadataPath, 0o644);
    await assert.rejects(
      execFile(process.execPath, [checker, "--metadata-path", metadataPath]),
      /permissions must be 0600/,
    );
    assert.equal(fs.readFileSync(metadataPath, "utf8"), before);
    assert.equal(fs.statSync(metadataPath).mode & 0o777, 0o644);

    fs.rmSync(metadataPath);
    fs.symlinkSync(path.join(directory, "missing-metadata.json"), metadataPath);
    await assert.rejects(
      execFile(process.execPath, [checker, "--json", "--metadata-path", metadataPath]),
      (error: any) => error.code === 2
        && JSON.parse(error.stdout).error === "metadata must be a regular non-symlink file",
    );
    fs.rmSync(metadataPath);
    fs.writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 1,
      credentials: { helper: { issuedAt: Date.now(), expiresAt: Date.now() + 10_000_000 } },
    }), { mode: 0o600 });
    fs.chmodSync(metadataPath, 0o600);
    await assert.rejects(
      execFile(process.execPath, [checker, "--json", "--metadata-path", metadataPath]),
      (error: any) => error.code === 2
        && JSON.parse(error.stdout).error === "metadata record for helper is invalid",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
