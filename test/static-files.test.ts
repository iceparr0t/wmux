import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serveStaticRequest } from "../src/server/static-files.js";

test("serves PNG static assets with their image MIME type", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wmux-static-files-"));
  fs.mkdirSync(path.join(root, "icons"));
  fs.writeFileSync(path.join(root, "icons", "app.png"), "png fixture");
  const server = http.createServer(async (request, response) => {
    const handled = await serveStaticRequest(
      request,
      response,
      new URL(request.url ?? "/", "http://127.0.0.1"),
      root,
    );
    if (!handled) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/icons/app.png`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(await response.text(), "png fixture");
  } finally {
    server.close();
    await once(server, "close");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
