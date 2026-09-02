import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuthConfig } from "../src/server/auth.js";
import {
  ScopedCredentialRotationError,
  ScopedCredentialStore,
  UnsupportedScopedCredentialVersionError,
} from "../src/server/scoped-credential-store.js";

const createAuth = (
  directory: string,
  fileBacked = true,
): AuthConfig => {
  const automationTokenPath = path.join(directory, "automation-token");
  const helperTokenPath = path.join(directory, "helper-token");
  fs.writeFileSync(automationTokenPath, `${"A".repeat(43)}\n`, { mode: 0o600 });
  fs.writeFileSync(helperTokenPath, `${"H".repeat(43)}\n`, { mode: 0o600 });
  return {
    enabled: true,
    token: "",
    loginEnabled: true,
    sessionSecret: "session-secret",
    browserAuthMode: "login-only",
    automationToken: "A".repeat(43),
    automationTokenPath: fileBacked ? automationTokenPath : undefined,
    helperToken: "H".repeat(43),
    helperTokenPath: fileBacked ? helperTokenPath : undefined,
  };
};

test("scoped credentials expire and rotation invalidates the old value", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-scoped-credentials-"),
  );
  try {
    const auth = createAuth(directory);
    const metadataPath = path.join(directory, "scoped-credentials.json");
    const nowMs = Date.now();
    const store = new ScopedCredentialStore(
      auth,
      metadataPath,
      60_000,
      nowMs,
    );
    const oldHelper = auth.helperToken!;
    assert.equal(store.authenticate(oldHelper, nowMs), "helper");
    assert.equal(store.authenticate(oldHelper, nowMs + 60_000), undefined);
    const rotated = store.rotate("helper", nowMs + 1_000);
    assert.equal(rotated.kind, "helper");
    assert.notEqual(auth.helperToken, oldHelper);
    assert.equal(store.authenticate(oldHelper, nowMs + 1_000), undefined);
    assert.equal(store.authenticate(auth.helperToken!, nowMs + 1_000), "helper");
    assert.equal(
      fs.readFileSync(auth.helperTokenPath!, "utf8").trim(),
      auth.helperToken,
    );
    assert.equal(fs.statSync(metadataPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(auth.helperTokenPath!).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(metadataPath, "utf8"), new RegExp(auth.helperToken!));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("environment-backed scoped credentials fail closed on rotation", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-scoped-environment-"),
  );
  try {
    const store = new ScopedCredentialStore(
      createAuth(directory, false),
      path.join(directory, "scoped-credentials.json"),
    );
    assert.throws(
      () => store.rotate("helper"),
      (error) =>
        error instanceof ScopedCredentialRotationError
        && error.code === "credential_not_file_backed",
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("scoped credential metadata refuses future schemas", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "wmux-scoped-future-"),
  );
  try {
    const metadataPath = path.join(directory, "scoped-credentials.json");
    fs.writeFileSync(metadataPath, JSON.stringify({
      schemaVersion: 2,
      credentials: {},
    }), { mode: 0o600 });
    assert.throws(
      () => new ScopedCredentialStore(createAuth(directory), metadataPath),
      UnsupportedScopedCredentialVersionError,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("renewal extends the same scoped secret and exposes expiry state", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-scoped-renewal-"));
  try {
    const auth = createAuth(directory);
    const nowMs = 1_000_000;
    const store = new ScopedCredentialStore(auth, path.join(directory, "scoped-credentials.json"), 10 * 24 * 60 * 60 * 1_000, nowMs);
    const before = store.list(nowMs + 4 * 24 * 60 * 60 * 1_000).find((record) => record.kind === "helper")!;
    assert.equal(before.expiryState, "near-expiry");
    assert.equal(before.renewable, true);
    const helper = auth.helperToken;
    const renewed = store.renew("helper", nowMs + 4 * 24 * 60 * 60 * 1_000);
    assert.equal(renewed.expiryState, "active");
    assert.equal(renewed.expiresInMs, 10 * 24 * 60 * 60 * 1_000);
    assert.equal(auth.helperToken, helper);
    assert.equal(store.authenticate(helper!, renewed.expiresAt - 1), "helper");
    assert.equal(store.list(renewed.expiresAt).find((record) => record.kind === "helper")!.expiryState, "expired");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
