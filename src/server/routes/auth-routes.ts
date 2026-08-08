import {
  issueSessionToken,
  verifyCredentials,
} from "../auth.js";
import { browserSessionCookie } from "../browser-session-cookie.js";
import { normalizeIpAddress, observedClientAddress } from "../proxy-address.js";
import {
  type ApiRoute,
  routePolicy,
} from "./route.js";
import {
  ScopedCredentialRotationError,
  type ScopedCredentialKind,
} from "../scoped-credential-store.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const authRoutes: readonly ApiRoute[] = [
  {
    id: "health",
    method: "GET",
    pattern: "/api/health",
    policy: routePolicy("health", "GET", "/api/health", "public"),
    handler: async ({ sendJson }) => {
      sendJson(200, { ok: true });
    },
  },
  {
    id: "repository-provenance",
    method: "GET",
    pattern: "/api/provenance",
    policy: routePolicy("repository-provenance", "GET", "/api/provenance"),
    handler: async ({ deps, sendJson }) => {
      sendJson(200, await deps.runtimeAttestor.current(), { "cache-control": "no-store" });
    },
  },
  {
    id: "auth-info",
    method: "GET",
    pattern: "/api/auth-info",
    policy: routePolicy("auth-info", "GET", "/api/auth-info", "public"),
    handler: async ({ deps, sendJson }) => {
      const { auth } = deps;
      sendJson(200, {
        authEnabled: auth.enabled,
        loginEnabled: auth.loginEnabled,
        browserAuthMode: auth.browserAuthMode ?? "shared-or-login",
      }, { "cache-control": "no-store" });
    },
  },
  {
    id: "login",
    method: "POST",
    pattern: "/api/login",
    policy: routePolicy("login", "POST", "/api/login", "public"),
    handler: async ({ deps, request, readJsonBody, sendJson }) => {
      const { auth, loginAttempts, trustedProxies } = deps;
      if (!auth.enabled || !auth.loginEnabled) {
        sendJson(404, { error: "login_disabled" }, { "cache-control": "no-store" });
        return;
      }
      const clientAddress = observedClientAddress(request, trustedProxies)
        ?? normalizeIpAddress(request.socket.remoteAddress)
        ?? "unknown";
      const attempt = loginAttempts.attempt(clientAddress);
      if (!attempt.allowed) {
        sendJson(
          429,
          { error: "login_rate_limited", retryAfterMs: attempt.retryAfterMs },
          {
            "retry-after": String(Math.max(1, Math.ceil(attempt.retryAfterMs / 1_000))),
            "cache-control": "no-store",
          },
        );
        return;
      }
      const body = (await readJsonBody()) as { username?: unknown; password?: unknown };
      if (typeof body.username !== "string" || typeof body.password !== "string") {
        sendJson(400, { error: "invalid_credentials_format" }, { "cache-control": "no-store" });
        return;
      }
      if (!await verifyCredentials(auth, body.username, body.password)) {
        sendJson(401, { error: "invalid_credentials" }, { "cache-control": "no-store" });
        return;
      }
      loginAttempts.reset(clientAddress);
      const nowMs = Date.now();
      if ((auth.browserAuthMode ?? "shared-or-login") === "login-only") {
        if (!deps.browserSessions) {
          throw new Error("login-only browser session store is unavailable");
        }
        const session = deps.browserSessions.issue(SESSION_TTL_MS, nowMs, {
          address: clientAddress,
          device: typeof request.headers["user-agent"] === "string"
            ? request.headers["user-agent"]
            : undefined,
        });
        sendJson(
          200,
          { authenticated: true, expiresInMs: SESSION_TTL_MS },
          {
            "cache-control": "no-store",
            "set-cookie": browserSessionCookie(
              session.token,
              session.expiresAt,
              Boolean(deps.browserSessionCookieSecure),
            ),
          },
        );
        return;
      }
      const token = issueSessionToken(
        auth.sessionSecret,
        SESSION_TTL_MS,
        nowMs,
      );
      sendJson(
        200,
        { token, expiresInMs: SESSION_TTL_MS },
        { "cache-control": "no-store" },
      );
    },
  },
  {
    id: "auth-session",
    method: "GET",
    pattern: "/api/auth/session",
    policy: routePolicy(
      "auth-session",
      "GET",
      "/api/auth/session",
      "normal",
      undefined,
      true,
    ),
    handler: async ({ sendJson }) => {
      sendJson(200, { authenticated: true }, { "cache-control": "no-store" });
    },
  },
  {
    id: "auth-sessions",
    method: "GET",
    pattern: "/api/auth/sessions",
    policy: routePolicy(
      "auth-sessions",
      "GET",
      "/api/auth/sessions",
      "normal",
      undefined,
      true,
    ),
    handler: async ({ deps, principal, sendJson }) => {
      if (!deps.browserSessions || principal.kind !== "browser-session") {
        sendJson(409, { error: "browser_session_inventory_unavailable" });
        return;
      }
      sendJson(200, {
        currentSessionId: principal.sessionId,
        sessions: deps.browserSessions.list(),
      }, { "cache-control": "no-store" });
    },
  },
  {
    id: "auth-session-revoke",
    method: "DELETE",
    pattern: /^\/api\/auth\/sessions\/([^/]+)$/,
    policy: routePolicy(
      "auth-session-revoke",
      "DELETE",
      /^\/api\/auth\/sessions\/([^/]+)$/,
      "normal",
      undefined,
      true,
    ),
    handler: async ({ deps, match, sendJson }) => {
      const sessionId = match?.[1] ?? "";
      if (!deps.browserSessions?.revoke(sessionId)) {
        sendJson(404, { error: "browser_session_not_found" });
        return;
      }
      sendJson(200, { revoked: true }, { "cache-control": "no-store" });
    },
  },
  {
    id: "auth-credentials",
    method: "GET",
    pattern: "/api/auth/credentials",
    policy: routePolicy(
      "auth-credentials",
      "GET",
      "/api/auth/credentials",
      "normal",
      undefined,
      true,
    ),
    handler: async ({ deps, sendJson }) => {
      sendJson(200, {
        credentials: deps.scopedCredentials?.list() ?? [],
      }, { "cache-control": "no-store" });
    },
  },
  {
    id: "auth-credential-rotate",
    method: "POST",
    pattern: /^\/api\/auth\/credentials\/(automation|helper)\/rotate$/,
    policy: routePolicy(
      "auth-credential-rotate",
      "POST",
      /^\/api\/auth\/credentials\/(automation|helper)\/rotate$/,
      "normal",
      undefined,
      true,
    ),
    handler: async ({ deps, match, sendJson }) => {
      if (!deps.scopedCredentials) {
        sendJson(409, { error: "scoped_credentials_unavailable" });
        return;
      }
      try {
        const credential = deps.scopedCredentials.rotate(
          match?.[1] as ScopedCredentialKind,
        );
        sendJson(200, { credential }, { "cache-control": "no-store" });
      } catch (error) {
        if (error instanceof ScopedCredentialRotationError) {
          sendJson(409, { error: error.code });
          return;
        }
        throw error;
      }
    },
  },
];
