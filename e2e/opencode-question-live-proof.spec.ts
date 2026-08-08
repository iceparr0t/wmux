import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AgentInputAnswerResult, BootstrapPayload, PaneServerMessage } from "../src/shared/protocol.js";
import {
  buildOpenCodeQuestionLiveProofArtifact,
  observeProofPaneClientMessage,
  parseOpenCodeQuestionLiveProofEnvironment,
} from "./opencode-question-live-proof-support.js";
import { createExternalApiRequestContext } from "./external-api-request.js";

const proof = parseOpenCodeQuestionLiveProofEnvironment();
const artifactPath = path.resolve("test-results/opencode-question-live-proof.json");

test("accepted deployment passes the OpenCode question hard server proof", async ({ page }) => {
  const request = createExternalApiRequestContext(proof.baseUrl, proof.token);
  fs.rmSync(artifactPath, { force: true });
  const startedAt = new Date().toISOString();
  const repositoryRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const repositoryStatus = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim();
  expect(repositoryRevision, "proof runner and deployed server must use the same revision").toBe(proof.expectedRevision);
  expect(repositoryStatus, "live proof requires a clean proof-runner checkout").toBe("");

  const authInfoResponse = await request.get("/api/auth-info");
  expect(authInfoResponse.ok()).toBeTruthy();
  const authInfo = await authInfoResponse.json() as { authEnabled?: unknown; browserAuthMode?: unknown };
  expect(authInfo.authEnabled, "proof requires server authentication").toBe(true);
  expect(authInfo.browserAuthMode, "proof currently requires shared-or-login browser authentication").toBe("shared-or-login");
  const unauthenticatedProvenance = await fetch(new URL("/api/provenance", proof.baseUrl), { redirect: "manual" });
  expect(unauthenticatedProvenance.status, "provenance must reject an unauthenticated request").toBe(401);

  const assertExactProvenance = async () => {
    const response = await request.get("/api/provenance");
    expect(response.ok()).toBeTruthy();
    const exact = { revision: proof.expectedRevision, clean: true, source: "live-git" };
    expect(await response.json()).toEqual({ runtime: "live-source", startup: exact, current: exact });
  };
  await assertExactProvenance();

  const initialBootstrapResponse = await request.get("/api/bootstrap");
  expect(initialBootstrapResponse.ok()).toBeTruthy();
  const initialBootstrap = await initialBootstrapResponse.json() as BootstrapPayload;
  const workspace = initialBootstrap.workspaces.find((candidate) => candidate.id === proof.workspaceId);
  expect(workspace, "accepted proof workspace must exist").toBeDefined();
  expect(workspace?.createdBy, "proof must not use an agent-created workspace").not.toBe("agent");
  expect(workspace?.parentWorkspaceId, "proof must use a root workspace").toBeUndefined();
  expect(workspace?.cleanupPolicy, "proof must not use an agent-owned one-shot workspace").toBeUndefined();
  const tab = workspace?.tabs.find((candidate) => candidate.id === proof.tabId);
  expect(tab, "accepted proof tab must exist").toBeDefined();
  expect(tab?.panes.some((candidate) => candidate.id === proof.paneId), "accepted proof pane must exist").toBe(true);

  let armed = false;
  let userInputMessagesAfterQuestion = 0;
  let terminalResponseMessagesAfterQuestion = 0;
  let answerBytesObserved = false;
  let syntheticEnterObserved = false;
  let paneOutput = "";
  let protectedAnswerValues: string[] = [];
  await page.routeWebSocket(new RegExp(`/ws/panes/${proof.paneId}(?:\\?.*)?$`), (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (armed) {
        const serialized = typeof message === "string" ? message : message.toString("utf8");
        const observation = observeProofPaneClientMessage(serialized, protectedAnswerValues);
        userInputMessagesAfterQuestion += observation.userInputMessages;
        terminalResponseMessagesAfterQuestion += observation.terminalResponseMessages;
        answerBytesObserved ||= observation.answerBytesObserved;
        syntheticEnterObserved ||= observation.syntheticEnterObserved;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message) as PaneServerMessage;
          if (parsed.type === "output") paneOutput += parsed.data;
          if (paneOutput.length > 1_000_000) paneOutput = paneOutput.slice(-1_000_000);
        } catch {
          // Non-protocol text is forwarded but cannot satisfy continuation.
        }
      }
      socket.send(message);
    });
  });

  const answerResponses: AgentInputAnswerResult[] = [];
  page.on("response", async (response) => {
    if (!/\/api\/agent-input\/requests\/[^/]+\/answer$/.test(new URL(response.url()).pathname)) return;
    try {
      answerResponses.push(await response.json() as AgentInputAnswerResult);
    } catch {
      // The explicit response assertion below reports a sanitized failure.
    }
  });

  await page.goto(`/workspaces/${encodeURIComponent(proof.workspaceId)}/tabs/${encodeURIComponent(proof.tabId)}`);
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".retro-boot-screen")).toHaveCount(0, { timeout: 20_000 });

  const nonce = crypto.randomBytes(8).toString("hex");
  const continuationMarker = `WMUX_QUESTION_PROOF_CONTINUED_${nonce}`;
  const prompt = [
    "Perform the authorized wmux structured-question hard proof now.",
    "Use the Interactive Question tool exactly once with exactly three questions in one call:",
    `1. header PROOF SINGLE, question Proof ${nonce}: choose one, options Alpha and Beta, multiple false, custom false.`,
    `2. header PROOF MULTI, question Proof ${nonce}: choose two, options One, Two, and Three, multiple true, custom false.`,
    `3. header PROOF CUSTOM, question Proof ${nonce}: enter a custom value, option Use custom, multiple false, custom true.`,
    "After the tool returns, do not quote, reproduce, or summarize any answer. On its own line, print WMUX_QUESTION_PROOF_CONTINUED_ followed immediately by the proof nonce already shown above, then stop.",
  ].join(" ");
  await page.evaluate(async ({ paneId, promptText }) => {
    await new Promise<void>((resolve, reject) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = new URLSearchParams({ cols: "100", rows: "32" });
      const token = window.localStorage.getItem("wmux.token");
      if (token) query.set("token", token);
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws/panes/${encodeURIComponent(paneId)}?${query}`);
      const timeout = window.setTimeout(() => reject(new Error("proof prompt pane did not become ready")), 20_000);
      socket.addEventListener("error", () => reject(new Error("proof prompt pane socket failed")), { once: true });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string; outputOnly?: boolean };
          if (message.type !== "ready") return;
          if (message.outputOnly) {
            reject(new Error("proof prompt requires a full-duplex pane socket"));
            return;
          }
          socket.send(JSON.stringify({ type: "input", data: `\u001b[200~${promptText}\u001b[201~` }));
          socket.send(JSON.stringify({ type: "input", data: "\r" }));
          window.setTimeout(() => {
            window.clearTimeout(timeout);
            socket.close();
            resolve();
          }, 500);
        } catch {
          // Wait for the protocol ready frame.
        }
      });
    });
  }, { paneId: proof.paneId, promptText: prompt });

  const card = page.locator(".agent-input-card").filter({ hasText: `Proof ${nonce}` });
  await expect(card, "a compatible real top-level OpenCode session must emit the proof request").toBeVisible({ timeout: 180_000 });
  await expect(card.locator("fieldset")).toHaveCount(3);
  await expect(card.locator("legend")).toHaveText(["PROOF SINGLE", "PROOF MULTI", "PROOF CUSTOM"]);
  const requestId = await card.getAttribute("data-request-id");
  expect(requestId).toBeTruthy();

  const serverProofResponse = await request.post("/api/proof/opencode-question", {
    data: { paneId: proof.paneId, nonce },
  });
  expect(serverProofResponse.status()).toBe(201);
  const serverProof = await serverProofResponse.json() as { id?: unknown };
  expect(serverProof.id).toMatch(/^[0-9a-f-]{36}$/);

  const customAnswer = `custom-${nonce}`;
  protectedAnswerValues = ["Alpha", "One", "Two", customAnswer];
  paneOutput = "";
  armed = true;
  await card.locator("fieldset").nth(0).getByRole("radio", { name: /Alpha/ }).check();
  await card.locator("fieldset").nth(1).getByRole("checkbox", { name: /One/ }).check();
  await card.locator("fieldset").nth(1).getByRole("checkbox", { name: /Two/ }).check();
  await card.getByRole("textbox", { name: "PROOF CUSTOM custom answer" }).fill(customAnswer);
  await card.getByRole("button", { name: /SUBMIT/ }).click();

  await expect.poll(() => answerResponses.at(-1)?.outcome, {
    message: "browser answer route must receive typed SDK delivery acknowledgement",
    timeout: 60_000,
  }).toBe("delivered");
  await expect(card).toHaveCount(0, { timeout: 60_000 });
  await expect.poll(() => paneOutput.includes(continuationMarker), {
    message: "the same OpenCode session must continue after accepting the structured reply",
    timeout: 180_000,
  }).toBe(true);

  const finalBootstrapResponse = await request.get("/api/bootstrap");
  expect(finalBootstrapResponse.ok()).toBeTruthy();
  const finalBootstrap = await finalBootstrapResponse.json() as BootstrapPayload;
  const finalRequest = finalBootstrap.agentInputRequests.find((candidate) => candidate.id === requestId);
  expect(finalRequest?.state).toBe("answered");
  expect(finalRequest?.resolution).toBe("user");
  const serverProofResultResponse = await request.delete(
    `/api/proof/opencode-question/${encodeURIComponent(String(serverProof.id))}`,
  );
  expect(serverProofResultResponse.ok()).toBeTruthy();
  const serverProofResult = await serverProofResultResponse.json() as {
    userWrites?: unknown;
    terminalResponseWrites?: unknown;
    answerBytesObserved?: unknown;
    syntheticEnterObserved?: unknown;
  };
  expect(Number.isInteger(serverProofResult.terminalResponseWrites)).toBe(true);
  expect(serverProofResult.userWrites, "actual backend boundary must receive no user writes after the question").toBe(0);
  expect(serverProofResult.answerBytesObserved, "actual backend boundary must receive no answer bytes").toBe(false);
  expect(serverProofResult.syntheticEnterObserved, "actual backend boundary must receive no synthetic Enter").toBe(false);
  expect(userInputMessagesAfterQuestion, "shelf submission must emit no user pane-input messages").toBe(0);
  expect(answerBytesObserved, "shelf submission must emit no answer bytes to pane input").toBe(false);
  expect(syntheticEnterObserved, "shelf submission must emit no synthetic Enter to pane input").toBe(false);
  await assertExactProvenance();

  const artifact = buildOpenCodeQuestionLiveProofArtifact({
    invocationId: proof.invocationId,
    target: proof.acceptedTarget,
    targetOriginSha256: proof.expectedOriginSha256,
    revision: repositoryRevision,
    startedAt,
    completedAt: new Date().toISOString(),
    terminalResponseMessagesAfterQuestion: Number(serverProofResult.terminalResponseWrites),
  });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const temporaryArtifactPath = `${artifactPath}.${proof.invocationId}.tmp`;
  fs.writeFileSync(temporaryArtifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temporaryArtifactPath, artifactPath);
  await request.dispose();
});
