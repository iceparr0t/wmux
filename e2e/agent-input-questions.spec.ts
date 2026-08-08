import { expect, test, type WebSocketRoute } from "./fixtures";
import type { AgentInputRequest, BootstrapPayload, PaneClientMessage, PaneServerMessage, TerminalNotification } from "../src/shared/protocol.js";

test("rendered OpenCode shelf submits exact answers, renders outcomes, routes notifications, and resyncs gaps", async ({ page, request }, testInfo) => {
  test.setTimeout(150_000);
  test.skip(testInfo.project.name !== "chromium", "desktop rendered evidence");
  const created = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(created.ok()).toBeTruthy();
  const createdWorkspace = (await created.json() as { workspace: BootstrapPayload["workspaces"][number] }).workspace;
  try {
    const baseline = await request.get("/api/bootstrap");
    const payload = await baseline.json() as BootstrapPayload;
    const target = payload.workspaces.find((workspace) => workspace.id !== createdWorkspace.id) ?? payload.workspaces[0]!;
    const targetTab = target.tabs[0]!;
    const targetPane = targetTab.panes[0]!;
    const now = new Date().toISOString();
    const makeRequest = (id: string, questions: AgentInputRequest["questions"]): AgentInputRequest => ({
      id,
      sourceId: "source-e2e",
      workspaceId: target.id,
      tabId: targetTab.id,
      paneId: targetPane.id,
      machineId: targetPane.machineId,
      openCodeSessionId: "session-e2e",
      openCodeRequestId: `oc-${id}`,
      generation: 7,
      questions,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const main = makeRequest("input-rendered-main", [
      { header: "Mode", question: "Choose one", options: [{ label: "Safe", description: "Safe mode" }], multiple: false, custom: false },
      { header: "Checks", question: "Choose checks", options: [{ label: "Tests", description: "Tests" }, { label: "Types", description: "Types" }], multiple: true, custom: false },
      { header: "Note", question: "Write a note", options: [], multiple: false, custom: true },
    ]);
    const sdkError = makeRequest("input-rendered-sdk-error", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const alreadyResolved = makeRequest("input-rendered-already-resolved", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const conflict = makeRequest("input-rendered-conflict", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const timedOut = makeRequest("input-rendered-timeout", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const unavailable = makeRequest("input-rendered-unavailable", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const submitting = makeRequest("input-rendered-submitting", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const deliveredPending = makeRequest("input-rendered-delivered-pending", [
      { header: "Mode", question: "Choose", options: [{ label: "Safe", description: "Safe" }], multiple: false, custom: false },
    ]);
    const resolveRequest = (
      requestItem: AgentInputRequest,
      state: AgentInputRequest["state"],
    ): AgentInputRequest => ({
      ...requestItem,
      state,
      resolution: "plugin",
      updatedAt: now,
      resolvedAt: now,
    });
    const answeredMain = resolveRequest(main, "answered");
    const answeredAlreadyResolved = resolveRequest(alreadyResolved, "answered");
    const failedSdkError = resolveRequest(sdkError, "failed");
    const staleRejected = resolveRequest(makeRequest("input-rendered-stale-rejected", sdkError.questions), "rejected");
    const staleCancelled = resolveRequest(makeRequest("input-rendered-stale-cancelled", sdkError.questions), "cancelled");
    const staleClosed = resolveRequest(makeRequest("input-rendered-stale-closed", sdkError.questions), "closed");
    const gapRequest = makeRequest("input-rendered-gap", [
      { header: "Gap", question: "Recovered", options: [{ label: "OK", description: "OK" }], multiple: false, custom: false },
    ]);
    const contiguousRequest = makeRequest("input-rendered-contiguous", [
      { header: "Delta", question: "Contiguous", options: [{ label: "OK", description: "OK" }], multiple: false, custom: false },
    ]);
    const deceptive = makeRequest("input-rendered-deceptive", [
      {
        header: "SAFE\u202Etxt",
        question: "Apply\u2066 now\u2069",
        options: [{ label: "Approve\u200F", description: "detail\u0007" }],
        multiple: false,
        custom: true,
      },
    ]);
    const href = `/workspaces/${encodeURIComponent(target.id)}/tabs/${encodeURIComponent(targetTab.id)}?agentInput=${main.id}&generation=${main.generation}`;
    const notification: TerminalNotification = {
      id: "agent-input-rendered-note",
      workspaceId: target.id,
      tabId: targetTab.id,
      paneId: targetPane.id,
      title: "OpenCode",
      subtitle: "input required",
      body: "OpenCode is waiting for structured input.",
      createdAt: now,
      read: true,
      agentInputRequestId: main.id,
      href,
    };
    let bootstrapPayload: any = {
      ...payload,
      activeWorkspaceId: createdWorkspace.id,
      notifications: [...payload.notifications, notification],
      agentInputRequests: [
        main,
        sdkError,
        alreadyResolved,
        conflict,
        timedOut,
        unavailable,
        submitting,
        deliveredPending,
        staleRejected,
        staleCancelled,
        staleClosed,
        deceptive,
      ],
      futureServerField: { ignoredByOlderClients: true },
    };
    let bootstrapCalls = 0;
    let eventSocket: WebSocketRoute | undefined;
    let currentRevision = payload.eventRevision;
    const submissions: Array<{ id: string; body: any }> = [];
    let paneInputCalls = 0;
    let releaseSubmitting: () => void = () => undefined;
    const submittingGate = new Promise<void>((resolve) => { releaseSubmitting = resolve; });
    await page.route("**/api/bootstrap", async (route) => {
      bootstrapCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(bootstrapPayload) });
    });
    await page.route("**/api/agent-input/requests/*/answer", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
      submissions.push({ id, body: route.request().postDataJSON() });
      if (id === submitting.id) await submittingGate;
      const result = id === main.id
        ? { status: 200, body: { outcome: "delivered" } }
        : id === deliveredPending.id
          ? { status: 200, body: { outcome: "delivered" } }
          : id === sdkError.id
            ? { status: 502, body: { outcome: "sdk_error", code: "delivery_ambiguous", retryable: false } }
            : id === alreadyResolved.id
              ? { status: 200, body: { outcome: "already_resolved" } }
              : id === conflict.id
                ? { status: 409, body: { outcome: "conflict", code: "idempotency_conflict" } }
                : id === timedOut.id
                  ? { status: 503, body: { outcome: "delivery_timeout" } }
                  : { status: 503, body: { outcome: "source_unavailable" } };
      await route.fulfill({ status: result.status, contentType: "application/json", body: JSON.stringify(result.body) });
      const terminal = id === main.id || id === alreadyResolved.id
        ? id === main.id ? answeredMain : answeredAlreadyResolved
        : id === sdkError.id
          ? failedSdkError
          : undefined;
      if (terminal && eventSocket) {
        const baseEventRevision = currentRevision;
        currentRevision += 1;
        eventSocket.send(JSON.stringify({
          type: "delta", baseEventRevision, eventRevision: currentRevision,
          revision: payload.revision, healthEpoch: payload.healthEpoch,
          agentInputRequests: { upserted: [{
            ...terminal,
            updatedAt: new Date().toISOString(), resolvedAt: new Date().toISOString(),
          }], removedIds: [] },
        }));
      }
    });
    await page.route("**/api/panes/*/input", async (route) => {
      paneInputCalls += 1;
      await route.continue();
    });
    await page.routeWebSocket("**/ws/events", (socket) => { eventSocket = socket; });
    await page.addInitScript(() => {
      const notifications: any[] = [];
      class CapturedNotification {
        static permission = "granted";
        onclick: (() => void) | null = null;
        constructor(public title: string, public options: NotificationOptions) { notifications.push(this); }
        close() {}
      }
      Object.defineProperty(window, "Notification", { configurable: true, value: CapturedNotification });
      Object.defineProperty(window, "__wmuxNotifications", { configurable: true, value: notifications });
    });
    await page.goto(href);
    await expect.poll(() => bootstrapCalls).toBeGreaterThan(0);
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => Boolean(eventSocket)).toBeTruthy();
    await page.waitForTimeout(200);
    expect(await page.evaluate(async () => (await (await fetch("/api/bootstrap")).json()).agentInputRequests.length)).toBe(12);
    for (const requestItem of [staleRejected, staleCancelled, staleClosed]) {
      await expect(page.locator(`[data-request-id="${requestItem.id}"]`)).toHaveCount(0);
    }
    const deceptiveCard = page.locator(`[data-request-id="${deceptive.id}"]`);
    await expect(deceptiveCard).toContainText("SAFE⟦U+202E⟧txt");
    await expect(deceptiveCard).toContainText("Apply⟦U+2066⟧ now⟦U+2069⟧");
    await expect(deceptiveCard.getByRole("radio")).toHaveAccessibleName("Approve⟦U+200F⟧ detail⟦U+0007⟧");
    await expect(deceptiveCard.getByRole("textbox")).toHaveAccessibleName("SAFE⟦U+202E⟧txt custom answer");
    expect(await deceptiveCard.textContent()).not.toMatch(/[\u0007\u200f\u202e\u2066\u2069]/u);

    const mainCard = page.locator(`[data-request-id="${main.id}"]`);
    await expect(mainCard).toBeVisible();
    await page.evaluate((targetHref) => {
      window.history.pushState(null, "", targetHref);
      window.dispatchEvent(new CustomEvent("wmux-notification-navigate", { detail: { href: targetHref } }));
    }, href);
    await expect(mainCard.locator("fieldset").nth(0).getByRole("radio")).toBeFocused();
    await page.waitForTimeout(700);
    await expect(mainCard.locator("fieldset").nth(0).getByRole("radio")).toBeFocused();
    await expect(page).not.toHaveURL(/agentInput=/);
    await expect(mainCard.locator("fieldset")).toHaveCount(3);
    await expect(mainCard.locator("legend")).toHaveText(["Mode", "Checks", "Note"]);
    await expect(mainCard.getByRole("radio", { name: /Safe/ })).toHaveCount(1);
    await expect(mainCard.getByRole("checkbox")).toHaveCount(2);
    await expect(mainCard.getByRole("checkbox").nth(0)).toHaveAccessibleName(/Tests/);
    await expect(mainCard.getByRole("checkbox").nth(1)).toHaveAccessibleName(/Types/);
    await expect(mainCard.getByRole("textbox")).toHaveCount(1);
    await expect(mainCard.getByRole("textbox", { name: "Mode custom answer" })).toHaveCount(0);
    await expect(mainCard.getByRole("textbox", { name: "Checks custom answer" })).toHaveCount(0);
    await expect(mainCard.getByRole("textbox", { name: "Note custom answer" })).toHaveAttribute("maxlength", "4096");
    await mainCard.getByRole("button", { name: /OPEN TERMINAL/ }).click();
    expect(paneInputCalls).toBe(0);

    await mainCard.locator("fieldset").nth(0).getByRole("radio").check();
    await mainCard.locator("fieldset").nth(1).getByRole("checkbox").nth(0).check();
    await mainCard.locator("fieldset").nth(1).getByRole("checkbox").nth(1).check();
    await mainCard.getByLabel("Note custom answer").fill("rendered custom answer");
    await mainCard.getByRole("button", { name: /SUBMIT/ }).click();
    await expect(mainCard).toHaveCount(0);
    expect(submissions.find((item) => item.id === main.id)?.body.answers).toEqual([
      ["Safe"], ["Tests", "Types"], ["rendered custom answer"],
    ]);

    for (const [requestItem, expectedState] of [
      [sdkError, "failed"],
      [conflict, "conflict"],
      [timedOut, "delivery_timeout"],
      [unavailable, "source_unavailable"],
    ] as const) {
      const card = page.locator(`[data-request-id="${requestItem.id}"]`);
      await card.getByRole("radio").check();
      await card.getByRole("button", { name: /SUBMIT/ }).click();
      await expect(card).toHaveAttribute("data-state", expectedState);
      await expect(card.locator("header span")).toHaveText(expectedState.replaceAll("_", " "));
    }
    const alreadyResolvedCard = page.locator(`[data-request-id="${alreadyResolved.id}"]`);
    await alreadyResolvedCard.getByRole("radio").check();
    await alreadyResolvedCard.getByRole("button", { name: /SUBMIT/ }).click();
    await expect(alreadyResolvedCard).toHaveCount(0);

    const submittingCard = page.locator(`[data-request-id="${submitting.id}"]`);
    await submittingCard.getByRole("radio").check();
    await submittingCard.getByRole("button", { name: /SUBMIT/ }).click();
    await expect(submittingCard).toHaveAttribute("data-state", "submitting");
    await expect(submittingCard).toBeVisible();
    releaseSubmitting();
    await expect(submittingCard).toHaveAttribute("data-state", "source_unavailable");

    const deliveredPendingCard = page.locator(`[data-request-id="${deliveredPending.id}"]`);
    await deliveredPendingCard.getByRole("radio").check();
    await deliveredPendingCard.getByRole("button", { name: /SUBMIT/ }).click();
    await expect(deliveredPendingCard).toHaveAttribute("data-state", "delivered");
    await expect(deliveredPendingCard).toBeVisible();

    eventSocket!.send(JSON.stringify({
      type: "delta",
      baseEventRevision: currentRevision,
      eventRevision: currentRevision + 1,
      revision: payload.revision,
      healthEpoch: payload.healthEpoch,
      agentInputRequests: { upserted: [contiguousRequest], removedIds: [] },
    }));
    currentRevision += 1;
    await expect(page.locator(`[data-request-id="${contiguousRequest.id}"]`)).toBeVisible();

    eventSocket!.send(JSON.stringify({ type: "notification", notification }));
    await expect.poll(() => page.evaluate((tag) => (
      (window as any).__wmuxNotifications.filter((item: any) => item.options?.tag === tag).length
    ), notification.id)).toBe(1);
    await page.evaluate((path) => {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/workspaces/${createdWorkspace.id}/tabs/${createdWorkspace.tabs[0]!.id}`);
    await expect(page).toHaveURL(new RegExp(createdWorkspace.id));
    await page.evaluate((tag) => (
      (window as any).__wmuxNotifications.find((item: any) => item.options?.tag === tag).onclick()
    ), notification.id);
    await expect(page).toHaveURL(new RegExp(target.id));
    await expect(page.locator(`a[href="/workspaces/${target.id}/tabs/${targetTab.id}"]`)).toHaveAttribute("aria-current", "page");
    await expect(mainCard).toHaveCount(0);
    await expect(page).not.toHaveURL(/agentInput=/);
    await page.evaluate((tag) => (
      (window as any).__wmuxNotifications.find((item: any) => item.options?.tag === tag).onclick()
    ), notification.id);
    await expect(page.locator(`a[href="/workspaces/${target.id}/tabs/${targetTab.id}"]`)).toHaveAttribute("aria-current", "page");
    await expect(page).not.toHaveURL(/agentInput=/);

    const callsBeforeGap = bootstrapCalls;
    bootstrapPayload = {
      ...payload,
      eventRevision: currentRevision + 10,
      agentInputRequests: [
        answeredMain,
        failedSdkError,
        answeredAlreadyResolved,
        conflict,
        timedOut,
        unavailable,
        submitting,
        deliveredPending,
        staleRejected,
        staleCancelled,
        staleClosed,
        deceptive,
        contiguousRequest,
        gapRequest,
      ],
      futureServerField: { ignoredByOlderClients: true },
    };
    eventSocket!.send(JSON.stringify({
      type: "delta",
      baseEventRevision: currentRevision + 5,
      eventRevision: currentRevision + 6,
      revision: payload.revision,
      healthEpoch: payload.healthEpoch,
      agentInputRequests: { upserted: [gapRequest], removedIds: [] },
    }));
    await expect.poll(() => bootstrapCalls).toBeGreaterThan(callsBeforeGap);
    await expect(page.locator(`[data-request-id="${gapRequest.id}"]`)).toBeVisible();
    await page.evaluate((path) => {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, `/workspaces/${createdWorkspace.id}/tabs/${createdWorkspace.tabs[0]!.id}`);
    await expect(page).toHaveURL(new RegExp(createdWorkspace.id));
    await expect(page.locator(`a[href="/workspaces/${createdWorkspace.id}/tabs/${createdWorkspace.tabs[0]!.id}"]`)).toHaveAttribute("aria-current", "page");
    await page.waitForTimeout(700);
    await expect(page).toHaveURL(new RegExp(createdWorkspace.id));
    await expect(page.locator(`a[href="/workspaces/${createdWorkspace.id}/tabs/${createdWorkspace.tabs[0]!.id}"]`)).toHaveAttribute("aria-current", "page");
  } finally {
    await request.delete(`/api/workspaces/${createdWorkspace.id}`).catch(() => undefined);
  }
});

test("old bootstrap without agentInputRequests renders safely with an agentInput deep link", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop old-server compatibility evidence");
  const baseline = await request.get("/api/bootstrap");
  const oldPayload = await baseline.json() as any;
  delete oldPayload.agentInputRequests;
  const workspace = oldPayload.workspaces[0];
  const tab = workspace.tabs[0];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/bootstrap", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(oldPayload),
  }));
  await page.goto(`/workspaces/${workspace.id}/tabs/${tab.id}?agentInput=additive-field-from-newer-notification&generation=1`);
  await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-request-id]")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("hard-proof instrumentation observes and delivers full-duplex pane input", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium", "desktop full-duplex proof instrumentation");
  const created = await request.post("/api/workspaces", { data: { machineId: "local" } });
  expect(created.ok()).toBeTruthy();
  const workspace = (await created.json() as { workspace: BootstrapPayload["workspaces"][number] }).workspace;
  const tab = workspace.tabs[0]!;
  const pane = tab.panes[0]!;
  const marker = "WMUX_FULL_DUPLEX_PROOF_SOCKET_OK";
  const octalMarker = [...marker].map((character) => `\\${character.charCodeAt(0).toString(8).padStart(3, "0")}`).join("");
  const command = `printf '${octalMarker}\\n'`;
  let observedInput = "";
  let observedOutput = "";
  try {
    await page.routeWebSocket(new RegExp(`/ws/panes/${pane.id}(?:\\?.*)?$`), (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message) as PaneClientMessage;
            if (parsed.type === "input") observedInput += parsed.data;
          } catch {
            // Forward malformed fixture traffic; the assertions cannot use it.
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (typeof message === "string") {
          try {
            const parsed = JSON.parse(message) as PaneServerMessage;
            if (parsed.type === "ready") observedOutput += parsed.replay;
            if (parsed.type === "output") observedOutput += parsed.data;
          } catch {
            // Forward malformed fixture traffic; the assertions cannot use it.
          }
        }
        socket.send(message);
      });
    });
    await page.goto(`/workspaces/${workspace.id}/tabs/${tab.id}`);
    await expect(page.locator("main.app-shell")).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => {
      const current = await request.get("/api/bootstrap");
      const payload = await current.json() as BootstrapPayload;
      return payload.workspaces.find((candidate) => candidate.id === workspace.id)
        ?.tabs.find((candidate) => candidate.id === tab.id)
        ?.panes.find((candidate) => candidate.id === pane.id)?.status;
    }, { timeout: 20_000 }).toBe("running");
    const proofStart = await request.post("/api/proof/opencode-question", {
      data: { paneId: pane.id, nonce: "0123456789abcdef" },
    });
    expect(proofStart.status()).toBe(201);
    const proofId = (await proofStart.json() as { id: string }).id;
    await page.evaluate(async ({ paneId, input }) => {
      await new Promise<void>((resolve, reject) => {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const query = new URLSearchParams({ cols: "100", rows: "32" });
        const token = window.localStorage.getItem("wmux.token");
        if (token) query.set("token", token);
        const socket = new WebSocket(`${protocol}//${window.location.host}/ws/panes/${encodeURIComponent(paneId)}?${query}`);
        const timeout = window.setTimeout(() => reject(new Error("full-duplex fixture socket timed out")), 20_000);
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") return;
          const message = JSON.parse(event.data) as { type?: string; outputOnly?: boolean };
          if (message.type !== "ready") return;
          if (message.outputOnly) {
            reject(new Error("fixture received an output-only socket"));
            return;
          }
          socket.send(JSON.stringify({ type: "input", data: input }));
          socket.send(JSON.stringify({ type: "input", data: "\r" }));
          socket.send(JSON.stringify({ type: "input", data: "Al", terminalResponse: true }));
          socket.send(JSON.stringify({ type: "input", data: "pha", terminalResponse: true }));
          window.clearTimeout(timeout);
          window.setTimeout(() => {
            socket.close();
            resolve();
          }, 250);
        });
      });
    }, { paneId: pane.id, input: command });
    await expect.poll(() => observedInput.includes(command)).toBe(true);
    expect(observedInput).not.toContain(marker);
    await expect.poll(() => observedOutput.includes(marker), { timeout: 20_000 }).toBe(true);
    const proofFinish = await request.delete(`/api/proof/opencode-question/${proofId}`);
    expect(proofFinish.ok()).toBeTruthy();
    expect(await proofFinish.json()).toMatchObject({
      userWrites: 2,
      terminalResponseWrites: 2,
      answerBytesObserved: true,
      syntheticEnterObserved: true,
    });
  } finally {
    await request.delete(`/api/workspaces/${workspace.id}`).catch(() => undefined);
  }
});
