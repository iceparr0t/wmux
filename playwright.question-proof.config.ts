import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resolveExternalE2eToken } from "./e2e/config-auth.js";
import { parseOpenCodeQuestionLiveProofEnvironment } from "./e2e/opencode-question-live-proof-support.js";

// Invalidate stale pass evidence before environment validation or browser
// startup; the wrapper also enforces invocation identity after Playwright exits.
fs.rmSync(path.resolve("test-results/opencode-question-live-proof.json"), { force: true });
const proof = parseOpenCodeQuestionLiveProofEnvironment();
const token = resolveExternalE2eToken(proof.baseUrl, proof.token)!;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "opencode-question-live-proof.spec.ts",
  outputDir: "test-results/opencode-question-live-proof-playwright",
  timeout: 360_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "line",
  use: {
    baseURL: proof.baseUrl,
    storageState: {
      cookies: [],
      origins: [{
        origin: new URL(proof.baseUrl).origin,
        localStorage: [{ name: "wmux.token", value: token }],
      }],
    },
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{
    name: "question-proof-chromium",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
  }],
});
