import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { comparePaddles, getPaddle, listBrands, loadSnapshot, resourceCatalog, searchPaddles } from "./lib/snapshot.mjs";

function result(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function toolOptions(description, inputSchema) {
  return {
    description,
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  };
}

const SERVER_INSTRUCTIONS = [
  "Read-only catalog of reviewed pickleball paddles from pickleball3.com.",
  "Use search_paddles with filters (brand, score range, purchase-link availability) before get_paddle or compare_paddles.",
  "Scores come from one published 100-point methodology; unknown measurements stay missing and are never estimated.",
  "Purchase links are sponsored, exact-model verified and observed-price gated; prices are published figures, not live prices.",
  "Cite the returned canonical_url and methodology_url when reusing a result. No personalized recommendations or advice.",
].join(" ");

export function createServer(snapshot) {
  const server = new McpServer({ name: "pickleball3", version: "1.1.0" }, { instructions: SERVER_INSTRUCTIONS });
  server.registerTool("search_paddles", toolOptions(
    "Search the current public Pickleball3 paddle catalog with deterministic bounded filters. Purchase links appear only for exact-model verified sponsored URLs.",
    {
      query: z.string().min(1).optional(), brand: z.string().min(1).optional(), year: z.number().int().optional(),
      min_score: z.number().min(0).max(100).optional(), max_score: z.number().min(0).max(100).optional(),
      has_purchase_link: z.boolean().optional(), limit: z.number().int().min(1).max(25).optional(),
      offset: z.number().int().min(0).max(500).optional(), sort: z.enum(["score_desc", "score_asc", "name_asc"]).optional(),
    },
  ), async (input) => result(searchPaddles(snapshot, input)));
  server.registerTool("get_paddle", toolOptions(
    "Get one exact public paddle record with scores, measured metrics, canonical citations and an eligible sponsored purchase link when available.",
    { slug: z.string().min(1) },
  ), async ({ slug }) => result(getPaddle(snapshot, slug)));
  server.registerTool("compare_paddles", toolOptions(
    "Compare two to four exact public paddles without generating a personalized recommendation or inventing missing measurements.",
    { slugs: z.array(z.string().min(1)).min(2).max(4) },
  ), async ({ slugs }) => result(comparePaddles(snapshot, slugs)));
  server.registerTool("list_paddle_brands", toolOptions(
    "List normalized brand names and public review counts in the current snapshot.",
    {},
  ), async () => result(listBrands(snapshot)));

  server.registerResource("paddle-dataset", "pickleball3://dataset/paddles", { title: "Pickleball3 paddle dataset", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(resourceCatalog(snapshot), null, 2) }],
  }));
  server.registerResource("paddle-methodology", "pickleball3://methodology/paddles", { title: "Pickleball3 paddle methodology", mimeType: "application/json" }, async (uri) => ({
    contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify({ methodology_url: snapshot.methodology_url, categories: ["control", "power", "spin", "sweet_spot", "stability", "maneuverability", "comfort", "forgiveness", "reach", "value"], total: 100 }, null, 2) }],
  }));
  server.registerResource("paddle", new ResourceTemplate("pickleball3://paddles/{slug}", {
    list: async () => ({ resources: snapshot.paddles.map((paddle) => ({ uri: `pickleball3://paddles/${paddle.slug}`, name: paddle.name, mimeType: "application/json" })) }),
  }), { title: "Pickleball3 paddle", mimeType: "application/json" }, async (uri, variables) => ({
    contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(getPaddle(snapshot, variables.slug).result, null, 2) }],
  }));
  return server;
}

export async function startStdio(snapshotPath) {
  const snapshot = loadSnapshot(snapshotPath);
  const server = createServer(snapshot);
  await server.connect(new StdioServerTransport());
  return server;
}
