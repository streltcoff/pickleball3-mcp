import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startHttpServer } from "./http-server.mjs";
import { loadSnapshot } from "./lib/snapshot.mjs";

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--snapshot") result.snapshot = argv[++i];
    else if (argv[i].startsWith("--snapshot=")) result.snapshot = argv[i].split("=", 2)[1];
    else if (argv[i] === "--port") result.port = argv[++i];
    else if (argv[i].startsWith("--port=")) result.port = argv[i].split("=", 2)[1];
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = args(argv);
  const snapshot = loadSnapshot(options.snapshot);
  const app = await startHttpServer(snapshot, { port: options.port });
  const address = app.server.address();
  console.error(`Pickleball3 MCP ready at http://127.0.0.1:${address.port}/mcp; dataset ${snapshot.dataset_version}.`);
  let shutdown;
  const close = (signal) => { if (!shutdown) shutdown = app.close().then(() => console.error(`Pickleball3 MCP stopped after ${signal}.`)); return shutdown; };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
  return app;
}

function realPath(value) {
  try { return realpathSync(value); } catch { return path.resolve(value); }
}

const entryPath = process.argv[1] ? realPath(process.argv[1]) : null;
if (entryPath && realPath(fileURLToPath(import.meta.url)) === entryPath) main().catch((error) => { console.error(`Fatal Pickleball3 MCP HTTP error: ${error.message}`); process.exit(1); });
