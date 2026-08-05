#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";

const fail = (message) => { throw new Error(message); };
const uid = process.getuid?.();
const [baseUrlText, metadataPath, expectedRevision] = process.argv.slice(2);

const readMetadata = (filePath) => {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    fail("staging metadata must be an owner-only mode-600 regular file");
  }
  const values = {};
  for (const line of fs.readFileSync(filePath, "utf8").trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) fail("malformed staging metadata");
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
};

const requestJson = (baseUrl, pathname, token) => new Promise((resolve, reject) => {
  const url = new URL(pathname, baseUrl);
  if (url.protocol !== "http:" || url.origin !== baseUrl.origin) return reject(new Error("smoke URL escaped its configured HTTP origin"));
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(totalTimer);
    if (error) reject(error); else resolve(value);
  };
  const request = http.request(url, {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    agent: false,
    maxHeaderSize: 32 * 1024,
  }, (response) => {
    if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
      response.destroy();
      finish(new Error(`smoke ${pathname} returned HTTP ${response.statusCode ?? 0}`));
      return;
    }
    const declared = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > 256 * 1024) {
      response.destroy();
      finish(new Error(`smoke ${pathname} response is oversized`));
      return;
    }
    let bytes = 0;
    const chunks = [];
    response.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) {
        response.destroy();
        finish(new Error(`smoke ${pathname} response exceeded 262144 bytes`));
      } else chunks.push(chunk);
    });
    response.on("end", () => {
      try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { finish(new Error(`smoke ${pathname} returned invalid JSON`)); }
    });
    response.on("error", (error) => finish(error));
  });
  const totalTimer = setTimeout(() => request.destroy(new Error(`smoke ${pathname} total timeout`)), 8_000);
  request.setTimeout(2_000, () => request.destroy(new Error(`smoke ${pathname} inactivity timeout`)));
  request.on("socket", (socket) => {
    if (socket.connecting) {
      const connectTimer = setTimeout(() => request.destroy(new Error(`smoke ${pathname} connect timeout`)), 2_000);
      socket.once("connect", () => clearTimeout(connectTimer));
      socket.once("error", () => clearTimeout(connectTimer));
    }
  });
  request.on("error", (error) => finish(error));
  request.end();
});

try {
  const baseUrl = new URL(baseUrlText);
  if (baseUrl.protocol !== "http:" || baseUrl.username || baseUrl.password || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    fail("staging smoke base URL must be a credential-free HTTP origin");
  }
  if (!/^[0-9a-f]{40,64}$/.test(expectedRevision ?? "")) fail("invalid expected build revision");
  const metadata = readMetadata(metadataPath);
  if (metadata.WMUX_BUILD_REVISION !== expectedRevision) fail("smoke metadata revision mismatch");
  if (!/^[0-9a-f]{64}$/.test(metadata.WMUX_TOKEN ?? "")) fail("invalid protected smoke token");
  const health = await requestJson(baseUrl, "/api/health", undefined);
  if (health?.ok !== true) fail("staging health response failed semantic validation");
  const bootstrap = await requestJson(baseUrl, "/api/bootstrap", metadata.WMUX_TOKEN);
  if (bootstrap?.settings?.groupSidebarSessionsByHost !== true) fail("staging bootstrap setting validation failed");
  process.stdout.write(`staging HTTP smoke passed for revision ${expectedRevision}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
