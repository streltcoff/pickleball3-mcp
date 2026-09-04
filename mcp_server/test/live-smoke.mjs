import assert from "node:assert/strict";

const base = String(process.argv[2] || "https://pickleball3.com").replace(/\/$/, "");
const endpoint = `${base}/mcp`;
const protocolVersion = "2025-11-25";

async function call(body, sessionId, expectedStatus = 200) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": protocolVersion,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${body.method}: HTTP ${response.status}: ${text.slice(0, 500)}`);
  if (expectedStatus === 202) return { payload: null, sessionId: response.headers.get("mcp-session-id") || sessionId };
  assert.match(response.headers.get("content-type") || "", /application\/json|text\/event-stream/);
  const payload = text.startsWith("event:")
    ? JSON.parse(text.split("\ndata: ").at(-1).trim())
    : JSON.parse(text);
  return { payload, sessionId: response.headers.get("mcp-session-id") || sessionId };
}

const discoveryResponse = await fetch(`${base}/.well-known/mcp.json`, { headers: { accept: "application/json" } });
assert.equal(discoveryResponse.status, 200);
const discovery = await discoveryResponse.json();
assert.equal(discovery.endpoint, endpoint);
assert.equal(discovery.record_count, 152);

const initialized = await call({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion, capabilities: {}, clientInfo: { name: "pickleball3-live-smoke", version: "1" } },
});
assert.equal(initialized.payload.result.serverInfo.name, "pickleball3");
assert.ok(initialized.sessionId);

await call({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, initialized.sessionId, 202);
const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, initialized.sessionId);
assert.deepEqual(tools.payload.result.tools.map((tool) => tool.name).sort(), ["compare_paddles", "get_paddle", "list_paddle_brands", "search_paddles"]);

const paddle = await call({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "get_paddle", arguments: { slug: "quartz-15mm-review" } },
}, initialized.sessionId);
assert.equal(paddle.payload.result.structuredContent.result.slug, "quartz-15mm-review");
assert.equal(paddle.payload.result.structuredContent.result.purchase.exact_model_verified, true);

console.log(`Pickleball3 MCP live smoke: PASS (${discovery.dataset_version.slice(0, 12)}, ${discovery.record_count} paddles)`);
