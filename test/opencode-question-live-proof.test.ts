import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  buildOpenCodeQuestionLiveProofArtifact,
  observeProofPaneClientMessage,
  parseOpenCodeQuestionLiveProofEnvironment,
} from "../e2e/opencode-question-live-proof-support.js";

const proofOrigin = "https://wmux-proof.example.test";
const validEnvironment = (): NodeJS.ProcessEnv => ({
  WMUX_E2E_BASE_URL: proofOrigin,
  WMUX_E2E_TOKEN: "x".repeat(32),
  WMUX_QUESTION_PROOF_ACCEPTED_TARGET: "accepted-staging",
  WMUX_QUESTION_PROOF_ACCEPTED_ORIGIN_SHA256: crypto.createHash("sha256").update(proofOrigin).digest("hex"),
  WMUX_QUESTION_PROOF_EXPECTED_REVISION: "a".repeat(40),
  WMUX_QUESTION_PROOF_INVOCATION_ID: "123e4567-e89b-42d3-a456-426614174000",
  WMUX_QUESTION_PROOF_WORKSPACE_ID: "ws_proof",
  WMUX_QUESTION_PROOF_TAB_ID: "tab_proof",
  WMUX_QUESTION_PROOF_PANE_ID: "pane_proof",
});

test("live question proof environment requires an explicit sanitized accepted target and clean revision", () => {
  assert.deepEqual(parseOpenCodeQuestionLiveProofEnvironment(validEnvironment()), {
    acceptedTarget: "accepted-staging",
    baseUrl: "https://wmux-proof.example.test",
    expectedOriginSha256: crypto.createHash("sha256").update(proofOrigin).digest("hex"),
    expectedRevision: "a".repeat(40),
    invocationId: "123e4567-e89b-42d3-a456-426614174000",
    paneId: "pane_proof",
    tabId: "tab_proof",
    token: "x".repeat(32),
    workspaceId: "ws_proof",
  });
  for (const [name, value] of [
    ["WMUX_QUESTION_PROOF_ACCEPTED_TARGET", "haswell unaccepted"],
    ["WMUX_QUESTION_PROOF_ACCEPTED_ORIGIN_SHA256", "0".repeat(64)],
    ["WMUX_QUESTION_PROOF_EXPECTED_REVISION", `${"a".repeat(40)}-dirty`],
    ["WMUX_QUESTION_PROOF_INVOCATION_ID", "not-a-uuid"],
    ["WMUX_E2E_BASE_URL", "https://user:secret@example.test/path"],
    ["WMUX_QUESTION_PROOF_PANE_ID", "../pane"],
  ] as const) {
    const env = validEnvironment();
    env[name] = value;
    assert.throws(() => parseOpenCodeQuestionLiveProofEnvironment(env));
  }
});

test("live question proof artifact is bounded to pass evidence and contains no answers, URLs, or pane/session IDs", () => {
  const artifact = buildOpenCodeQuestionLiveProofArtifact({
    invocationId: "123e4567-e89b-42d3-a456-426614174000",
    target: "accepted-staging",
    targetOriginSha256: "c".repeat(64),
    revision: "b".repeat(40),
    startedAt: "2026-08-07T10:00:00.000Z",
    completedAt: "2026-08-07T10:01:00.000Z",
    terminalResponseMessagesAfterQuestion: 2,
  });
  const serialized = JSON.stringify(artifact);
  assert.equal(artifact.status, "passed");
  assert.equal(artifact.assertions.paneInput.userInputMessagesAfterQuestion, 0);
  assert.equal(artifact.privacy.rawAnswersRecorded, false);
  assert.doesNotMatch(serialized, /https?:|ws_proof|tab_proof|pane_proof|private-answer-value/i);
});

test("live proof pane observer fails closed for ordinary, malformed, and disguised answer input", () => {
  assert.deepEqual(observeProofPaneClientMessage(JSON.stringify({ type: "resize", cols: 80, rows: 24 }), ["private"]), {
    userInputMessages: 0,
    terminalResponseMessages: 0,
    answerBytesObserved: false,
    syntheticEnterObserved: false,
  });
  assert.deepEqual(observeProofPaneClientMessage(JSON.stringify({ type: "input", data: "private", terminalResponse: true }), ["private"]), {
    userInputMessages: 0,
    terminalResponseMessages: 1,
    answerBytesObserved: true,
    syntheticEnterObserved: false,
  });
  assert.equal(observeProofPaneClientMessage(JSON.stringify({ type: "input", data: "\r", terminalResponse: true }), []).syntheticEnterObserved, true);
  assert.equal(observeProofPaneClientMessage("malformed private\n", ["private"]).userInputMessages, 1);
});

test("live proof wrapper invalidates stale evidence before launch and binds a fresh invocation", () => {
  const wrapper = fs.readFileSync("scripts/run-opencode-question-live-proof.mjs", "utf8");
  const config = fs.readFileSync("playwright.question-proof.config.ts", "utf8");
  assert.ok(wrapper.indexOf("fs.rmSync(artifactPath") < wrapper.indexOf("spawnSync("));
  assert.match(wrapper, /crypto\.randomUUID\(\)/);
  assert.match(wrapper, /WMUX_QUESTION_PROOF_INVOCATION_ID: invocationId/);
  assert.match(wrapper, /artifact\?\.invocationId !== invocationId/);
  assert.ok(config.indexOf("fs.rmSync(") < config.indexOf("parseOpenCodeQuestionLiveProofEnvironment()"));
});
