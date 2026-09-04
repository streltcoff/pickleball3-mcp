import assert from "node:assert/strict";
import { request as nodeRequest } from "node:http";
import { startHttpServer } from "../http-server.mjs";
import { loadSnapshot } from "../lib/snapshot.mjs";

const snapshot = loadSnapshot();
assert.equal(snapshot.record_count, 152);
assert.match(snapshot.dataset_version, /^[a-f0-9]{64}$/);
assert.ok(snapshot.paddles.some((paddle) => paddle.purchase?.exact_model_verified));
assert.ok(snapshot.paddles.every((paddle) => !paddle.purchase || (paddle.purchase.sponsored && paddle.purchase.current_offer?.observed_at)));

const app = await startHttpServer(snapshot, { port: 0, rateMax: 100 });
const address = app.server.address();
const base = `http://127.0.0.1:${address.port}`;
const protocolVersion = "2025-11-25";

function http(method, pathname, body, headers = {}) {
  const raw = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = nodeRequest(`${base}${pathname}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let payload = text;
        try { payload = text ? JSON.parse(text) : null; } catch {}
        resolve({ res, payload, text });
      });
    });
    req.on("error", reject);
    if (raw !== null) req.write(raw);
    req.end();
  });
}

function headers(sessionId) {
  return { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": protocolVersion, ...(sessionId ? { "mcp-session-id": sessionId } : {}) };
}

try {
  const health = await http("GET", "/healthz");
  assert.equal(health.res.statusCode, 200);
  assert.equal(health.payload.service, "pickleball3-mcp");
  assert.equal(health.text.includes("/Users/"), false);

  const initialize = await http("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "pickleball3-conformance", version: "1" } } }, headers());
  assert.equal(initialize.res.statusCode, 200);
  assert.equal(initialize.payload.result.serverInfo.name, "pickleball3");
  assert.equal(initialize.payload.result.serverInfo.version, "1.1.0");
  assert.ok(initialize.payload.result.instructions.includes("Read-only catalog"));
  const sessionId = initialize.res.headers["mcp-session-id"];
  assert.match(sessionId, /^[0-9a-f-]{36}$/);

  await http("POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, headers(sessionId));
  const tools = await http("POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, headers(sessionId));
  assert.deepEqual(tools.payload.result.tools.map((tool) => tool.name).sort(), ["compare_paddles", "get_paddle", "list_paddle_brands", "search_paddles"]);
  assert.ok(tools.payload.result.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false));

  const get = await http("POST", "/mcp", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_paddle", arguments: { slug: "quartz-15mm-review" } } }, headers(sessionId));
  assert.equal(get.res.statusCode, 200);
  assert.equal(get.payload.result.structuredContent.result.slug, "quartz-15mm-review");
  assert.equal(get.payload.result.structuredContent.result.purchase.exact_model_verified, true);

  const search = await http("POST", "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search_paddles", arguments: { brand: "CRBN", limit: 3 } } }, headers(sessionId));
  assert.equal(search.payload.result.structuredContent.result.count, 3);
  assert.ok(search.payload.result.structuredContent.result.total >= 3);

  const compare = await http("POST", "/mcp", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "compare_paddles", arguments: { slugs: ["ben-johns-perseus-cfs-16mm-review", "ben-johns-hyperion-cfs-16mm-review"] } } }, headers(sessionId));
  assert.equal(compare.payload.result.structuredContent.result.paddles.length, 2);
  assert.ok(compare.payload.result.structuredContent.result.metric_matrix.length > 0);

  const resources = await http("POST", "/mcp", { jsonrpc: "2.0", id: 6, method: "resources/templates/list", params: {} }, headers(sessionId));
  assert.ok(resources.payload.result.resourceTemplates.some((item) => item.uriTemplate === "pickleball3://paddles/{slug}"));

  const wrongHost = await http("GET", "/healthz", undefined, { host: `evil.example:${address.port}` });
  assert.equal(wrongHost.res.statusCode, 403);
  const wrongOrigin = await http("GET", "/healthz", undefined, { host: `127.0.0.1:${address.port}`, origin: "https://evil.example" });
  assert.equal(wrongOrigin.res.statusCode, 403);
  const malformed = await http("POST", "/mcp", "{", headers());
  assert.equal(malformed.res.statusCode, 400);
  const wrongContent = await http("POST", "/mcp", {}, { "content-type": "text/plain" });
  assert.equal(wrongContent.res.statusCode, 415);
  const tooLarge = await http("POST", "/mcp", "x".repeat(70_000), { ...headers(), "content-length": "70000" });
  assert.equal(tooLarge.res.statusCode, 413);
  console.log("Pickleball3 MCP conformance: PASS");
} finally {
  await app.close();
}
