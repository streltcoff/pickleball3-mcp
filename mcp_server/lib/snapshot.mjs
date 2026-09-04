import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SNAPSHOT = path.resolve(HERE, "..", "..", "public", "data", "mcp", "snapshot.json");

function cleanText(value) {
  return String(value ?? "").trim().toLowerCase();
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Expected integer ${min}..${max}.`);
  return number;
}

export function resolveSnapshotPath(explicitPath) {
  return path.resolve(explicitPath || process.env.PICKLEBALL3_MCP_SNAPSHOT || DEFAULT_SNAPSHOT);
}

export function loadSnapshot(explicitPath) {
  const filePath = resolveSnapshotPath(explicitPath);
  const snapshot = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (snapshot.schema_version !== "pickleball3-mcp-snapshot-v1") throw new Error("Unsupported Pickleball3 MCP snapshot schema.");
  if (!Array.isArray(snapshot.paddles) || snapshot.paddles.length !== snapshot.record_count) throw new Error("MCP snapshot record count mismatch.");
  const slugs = new Set();
  for (const paddle of snapshot.paddles) {
    if (!paddle || typeof paddle !== "object" || !paddle.slug || !paddle.canonical_url) throw new Error("MCP snapshot contains an invalid paddle.");
    if (slugs.has(paddle.slug)) throw new Error(`Duplicate MCP paddle slug: ${paddle.slug}`);
    slugs.add(paddle.slug);
    if (paddle.purchase && (!paddle.purchase.exact_model_verified || !paddle.purchase.sponsored || !String(paddle.purchase.url).startsWith("https://"))) {
      throw new Error(`Unsafe purchase payload: ${paddle.slug}`);
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(snapshot.dataset_version || ""))) throw new Error("MCP snapshot dataset version is invalid.");
  return { ...snapshot, _path: filePath };
}

function datasetMeta(snapshot) {
  return {
    schema_version: snapshot.schema_version,
    dataset_version: snapshot.dataset_version,
    source_endpoint: snapshot.source_endpoint,
    methodology_url: snapshot.methodology_url,
    generated: snapshot.generated,
    updated: snapshot.updated,
    record_count: snapshot.record_count,
  };
}

function envelope(snapshot, tool, input, result, warnings = []) {
  return {
    schema_version: "pickleball3-mcp-response-v1",
    tool,
    normalized_input: input,
    dataset: datasetMeta(snapshot),
    result,
    warnings,
  };
}

export function searchPaddles(snapshot, input = {}) {
  const normalized = {
    query: cleanText(input.query),
    brand: cleanText(input.brand),
    year: input.year ?? null,
    min_score: input.min_score ?? null,
    max_score: input.max_score ?? null,
    has_purchase_link: input.has_purchase_link ?? null,
    limit: boundedInteger(input.limit, 10, 1, 25),
    offset: boundedInteger(input.offset, 0, 0, 500),
    sort: input.sort || "score_desc",
  };
  let rows = snapshot.paddles.filter((paddle) => {
    const haystack = [paddle.name, paddle.model, paddle.brand, paddle.shape, ...(paddle.play_style || [])].map(cleanText).join(" ");
    if (normalized.query && !haystack.includes(normalized.query)) return false;
    if (normalized.brand && cleanText(paddle.brand) !== normalized.brand) return false;
    if (normalized.year !== null && Number(paddle.year) !== Number(normalized.year)) return false;
    if (normalized.min_score !== null && Number(paddle.score) < Number(normalized.min_score)) return false;
    if (normalized.max_score !== null && Number(paddle.score) > Number(normalized.max_score)) return false;
    if (normalized.has_purchase_link !== null && Boolean(paddle.purchase) !== Boolean(normalized.has_purchase_link)) return false;
    return true;
  });
  const sorters = {
    score_desc: (a, b) => Number(b.score || 0) - Number(a.score || 0) || a.slug.localeCompare(b.slug),
    score_asc: (a, b) => Number(a.score || 0) - Number(b.score || 0) || a.slug.localeCompare(b.slug),
    name_asc: (a, b) => String(a.name).localeCompare(String(b.name)) || a.slug.localeCompare(b.slug),
  };
  if (!sorters[normalized.sort]) throw new Error("Unsupported sort.");
  rows = rows.sort(sorters[normalized.sort]);
  const items = rows.slice(normalized.offset, normalized.offset + normalized.limit);
  return envelope(snapshot, "search_paddles", normalized, {
    total: rows.length,
    count: items.length,
    next_offset: normalized.offset + items.length < rows.length ? normalized.offset + items.length : null,
    items,
  });
}

export function getPaddle(snapshot, slug) {
  const normalizedSlug = cleanText(slug).replace(/^\/+|\/+$/g, "");
  const paddle = snapshot.paddles.find((item) => item.slug === normalizedSlug) || null;
  return envelope(snapshot, "get_paddle", { slug: normalizedSlug }, paddle, paddle ? [] : ["Paddle is not available in the current public snapshot."]);
}

export function comparePaddles(snapshot, slugs) {
  const normalizedSlugs = [...new Set((slugs || []).map((slug) => cleanText(slug).replace(/^\/+|\/+$/g, "")))];
  if (normalizedSlugs.length < 2 || normalizedSlugs.length > 4) throw new Error("compare_paddles requires two to four distinct slugs.");
  const paddles = normalizedSlugs.map((slug) => snapshot.paddles.find((item) => item.slug === slug)).filter(Boolean);
  const missing = normalizedSlugs.filter((slug) => !paddles.some((item) => item.slug === slug));
  const scoreCategories = [...new Set(paddles.flatMap((item) => Object.keys(item.scores || {})))].sort();
  const metricNames = [...new Set(paddles.flatMap((item) => Object.keys(item.metrics || {})))].sort();
  return envelope(snapshot, "compare_paddles", { slugs: normalizedSlugs }, {
    paddles,
    score_matrix: scoreCategories.map((category) => ({ category, values: Object.fromEntries(paddles.map((item) => [item.slug, item.scores?.[category] ?? null])) })),
    metric_matrix: metricNames.map((metric) => ({ metric, values: Object.fromEntries(paddles.map((item) => [item.slug, item.metrics?.[metric] ?? { known: false }])) })),
  }, missing.map((slug) => `Not available: ${slug}`));
}

export function listBrands(snapshot) {
  const counts = new Map();
  for (const paddle of snapshot.paddles) counts.set(paddle.brand, (counts.get(paddle.brand) || 0) + 1);
  const brands = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  return envelope(snapshot, "list_paddle_brands", {}, { brands });
}

export function resourceCatalog(snapshot) {
  return { ...datasetMeta(snapshot), affiliate_policy: snapshot.affiliate_policy, paddles: snapshot.paddles };
}
