#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifactPath = path.join(root, "test-results", "opencode-question-live-proof.json");
const invocationId = crypto.randomUUID();
const temporaryArtifactPath = `${artifactPath}.${invocationId}.tmp`;
fs.rmSync(artifactPath, { force: true });
fs.rmSync(temporaryArtifactPath, { force: true });

const cli = path.join(root, "node_modules", "@playwright", "test", "cli.js");
const result = spawnSync(process.execPath, [cli, "test", "--config=playwright.question-proof.config.ts"], {
  cwd: root,
  env: { ...process.env, WMUX_QUESTION_PROOF_INVOCATION_ID: invocationId },
  stdio: "inherit",
});
if (result.error || result.status !== 0) {
  fs.rmSync(artifactPath, { force: true });
  fs.rmSync(temporaryArtifactPath, { force: true });
  if (result.error) console.error("OpenCode question proof runner failed to start");
  process.exit(result.status ?? 1);
}

try {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (artifact?.status !== "passed" || artifact?.invocationId !== invocationId) {
    throw new Error("proof artifact does not match this invocation");
  }
} catch {
  fs.rmSync(artifactPath, { force: true });
  fs.rmSync(temporaryArtifactPath, { force: true });
  console.error("OpenCode question proof completed without fresh matching pass evidence");
  process.exit(1);
}
