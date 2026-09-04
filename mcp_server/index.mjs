import path from "node:path";
import { fileURLToPath } from "node:url";
import { startStdio } from "./server.mjs";

function snapshotArg(argv) {
  const index = argv.indexOf("--snapshot");
  return index >= 0 ? argv[index + 1] : argv.find((item) => item.startsWith("--snapshot="))?.split("=", 2)[1];
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  startStdio(snapshotArg(process.argv.slice(2))).catch((error) => {
    console.error(`Fatal Pickleball3 MCP error: ${error.message}`);
    process.exit(1);
  });
}
