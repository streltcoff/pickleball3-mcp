import { createServer as createNodeServer } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer as createMcpServer } from "./server.mjs";

const DEFAULTS = {
  host: "127.0.0.1", port: 8788, maxBodyBytes: 64 * 1024, maxResponseBytes: 4 * 1024 * 1024,
  rateWindowMs: 60_000, rateMax: 60, maxSessions: 100, sessionTtlMs: 15 * 60_000,
};

function numberOption(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid MCP HTTP numeric option: ${value}`);
  return number;
}

function listOption(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function resolveHttpConfig(options = {}) {
  const host = String(options.host || process.env.PICKLEBALL3_MCP_HTTP_HOST || DEFAULTS.host);
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Pickleball3 MCP must bind to a loopback address.");
  const port = numberOption(options.port ?? process.env.PICKLEBALL3_MCP_HTTP_PORT, DEFAULTS.port, 0, 65535);
  const allowedHosts = listOption(options.allowedHosts ?? process.env.PICKLEBALL3_MCP_HTTP_ALLOWED_HOSTS);
  const allowedOrigins = listOption(options.allowedOrigins ?? process.env.PICKLEBALL3_MCP_HTTP_ALLOWED_ORIGINS);
  if ([...allowedHosts, ...allowedOrigins].some((value) => value.includes("*"))) throw new Error("Wildcard MCP hosts and origins are not allowed.");
  return {
    host, port, allowedHosts, allowedOrigins,
    maxBodyBytes: numberOption(options.maxBodyBytes ?? process.env.PICKLEBALL3_MCP_HTTP_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, 1024, 1024 * 1024),
    maxResponseBytes: numberOption(options.maxResponseBytes ?? process.env.PICKLEBALL3_MCP_HTTP_MAX_RESPONSE_BYTES, DEFAULTS.maxResponseBytes, 1024, 16 * 1024 * 1024),
    rateWindowMs: numberOption(options.rateWindowMs ?? process.env.PICKLEBALL3_MCP_HTTP_RATE_WINDOW_MS, DEFAULTS.rateWindowMs, 1000, 3_600_000),
    rateMax: numberOption(options.rateMax ?? process.env.PICKLEBALL3_MCP_HTTP_RATE_MAX, DEFAULTS.rateMax, 1, 10_000),
    maxSessions: numberOption(options.maxSessions ?? process.env.PICKLEBALL3_MCP_HTTP_MAX_SESSIONS, DEFAULTS.maxSessions, 1, 1000),
    sessionTtlMs: numberOption(options.sessionTtlMs ?? process.env.PICKLEBALL3_MCP_HTTP_SESSION_TTL_MS, DEFAULTS.sessionTtlMs, 1000, 3_600_000),
  };
}

function send(res, status, payload, jsonRpc = false) {
  if (res.headersSent) return res.destroy();
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(jsonRpc ? { jsonrpc: "2.0", error: payload, id: null } : payload));
}

function requestPath(req) {
  try { return new URL(req.url || "/", "http://localhost").pathname; } catch { return null; }
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error("Request body is too large."), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Malformed JSON request."), { status: 400 }); }
}

function installResponseLimit(res, maxBytes) {
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  let total = 0;
  const size = (chunk, encoding) => chunk == null ? 0 : Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding);
  res.write = (chunk, encoding, callback) => {
    total += size(chunk, encoding);
    if (total > maxBytes) { res.destroy(new Error("MCP response is too large.")); return false; }
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    total += size(chunk, encoding);
    if (total > maxBytes) { res.destroy(new Error("MCP response is too large.")); return res; }
    return originalEnd(chunk, encoding, callback);
  };
}

export function createHttpServer(snapshot, options = {}) {
  const config = resolveHttpConfig(options);
  const sessions = new Map();
  const rates = new Map();
  let closing = false;
  const server = createNodeServer(async (req, res) => {
    installResponseLimit(res, config.maxResponseBytes);
    const actualPort = typeof server.address() === "object" ? server.address().port : config.port;
    const allowedHosts = config.allowedHosts.length ? config.allowedHosts : [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`];
    if (!allowedHosts.map((item) => item.toLowerCase()).includes(String(req.headers.host || "").toLowerCase())) return send(res, 403, { error: "Host is not allowed." });
    const origin = String(req.headers.origin || "");
    const allowedOrigins = config.allowedOrigins.length ? config.allowedOrigins : [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];
    if (origin && !allowedOrigins.includes(origin)) return send(res, 403, { error: "Origin is not allowed." });
    const now = Date.now();
    for (const [id, record] of sessions) {
      if (now - record.lastSeen > config.sessionTtlMs) {
        sessions.delete(id);
        void record.transport.close().catch(() => {});
      }
    }
    const forwardedAddress = String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim();
    const rateKey = forwardedAddress || req.socket.remoteAddress || "unknown";
    if (rates.size > 5000) {
      for (const [key, value] of rates) if (now - value.start >= config.rateWindowMs) rates.delete(key);
    }
    let bucket = rates.get(rateKey);
    if (!bucket || now - bucket.start >= config.rateWindowMs) { bucket = { start: now, count: 0 }; rates.set(rateKey, bucket); }
    bucket.count += 1;
    if (bucket.count > config.rateMax) { res.setHeader("retry-after", "60"); return send(res, 429, { error: "Rate limit exceeded." }); }
    const pathname = requestPath(req);
    if (pathname === "/healthz") return req.method === "GET" ? send(res, 200, { status: closing ? "shutting_down" : "ok", service: "pickleball3-mcp", transport: "streamable-http", dataset_version: snapshot.dataset_version, record_count: snapshot.record_count }) : send(res, 405, { error: "Method not allowed." });
    if (pathname !== "/mcp") return send(res, 404, { error: "Not found." });
    if (!["POST", "GET", "DELETE"].includes(req.method)) { res.setHeader("allow", "GET, POST, DELETE"); return send(res, 405, { code: -32000, message: "Method not allowed." }, true); }
    if (closing) return send(res, 503, { code: -32000, message: "Server is shutting down." }, true);

    let body;
    if (req.method === "POST") {
      if (String(req.headers["content-type"] || "").split(";", 1)[0].toLowerCase() !== "application/json") { req.resume(); return send(res, 415, { code: -32000, message: "Content-Type must be application/json." }, true); }
      try { body = await readBody(req, config.maxBodyBytes); } catch (error) { return send(res, error.status || 400, { code: error.status === 413 ? -32000 : -32700, message: error.message }, true); }
    }
    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : null;
    let record = sessionId ? sessions.get(sessionId) : null;
    if (sessionId && !record) return send(res, 404, { code: -32001, message: "Session not found." }, true);
    if (!record) {
      if (req.method !== "POST" || Array.isArray(body) || !isInitializeRequest(body)) return send(res, 400, { code: -32000, message: "A valid MCP session is required." }, true);
      if (sessions.size >= config.maxSessions) return send(res, 503, { code: -32000, message: "Session capacity reached." }, true);
      let created;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
        allowedHosts, allowedOrigins, enableDnsRebindingProtection: true,
        onsessioninitialized: (id) => sessions.set(id, created),
      });
      created = { mcp: createMcpServer(snapshot), transport, lastSeen: now };
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await created.mcp.connect(transport);
      record = created;
    }
    record.lastSeen = now;
    try { await record.transport.handleRequest(req, res, req.method === "POST" ? body : undefined); }
    catch { if (!res.headersSent) send(res, 500, { code: -32603, message: "MCP request failed." }, true); else res.destroy(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  return {
    server, config, sessions,
    async listen() { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(config.port, config.host, resolve); }); return server.address(); },
    async close() { closing = true; rates.clear(); await Promise.allSettled([...sessions.values()].map((item) => item.transport.close())); if (server.listening) await new Promise((resolve) => server.close(resolve)); },
  };
}

export async function startHttpServer(snapshot, options = {}) {
  const app = createHttpServer(snapshot, options);
  await app.listen();
  return app;
}
