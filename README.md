# Pickleball3 Paddle Catalog MCP

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for
the pickleball paddle review catalog of [pickleball3.com](https://pickleball3.com/) —
search, compare and inspect reviewed paddles with scores from one published
100-point methodology, measured specs, and verified sponsored purchase links.

- **Live endpoint (Streamable HTTP, no auth):** `https://pickleball3.com/mcp`
- **Discovery:** `https://pickleball3.com/.well-known/mcp.json`
- **Client docs:** `https://pickleball3.com/api/`
- **Official MCP Registry:** `io.github.gospodindark-stack/pickleball3` (active, latest)
- **Methodology:** `https://pickleball3.com/methodology/`

## Tools

| Tool | What it does |
|---|---|
| `search_paddles` | Bounded search over the catalog (query, brand, year, score range, purchase-link availability; sort; pagination). |
| `get_paddle` | One exact paddle: scores, measured metrics, canonical citations, eligible sponsored purchase link. |
| `compare_paddles` | Deterministic side-by-side comparison of 2–4 paddles. |
| `list_paddle_brands` | Normalized brand names and review counts. |

## Resources

- `pickleball3://dataset/paddles` — the full catalog dataset
- `pickleball3://methodology/paddles` — scoring categories
- `pickleball3://paddles/{slug}` — one published paddle record

Every tool response includes the response schema, normalized input, dataset
version, source endpoint, methodology URL and warnings. Unknown measurements
stay missing — nothing is estimated. The server does not produce personalized
recommendations, medical advice, live prices or stock claims.

## Client configuration

Claude Desktop / Cursor / any MCP client that supports Streamable HTTP:

```json
{
  "mcpServers": {
    "pickleball3": {
      "url": "https://pickleball3.com/mcp"
    }
  }
}
```

## Run locally

The repository mirrors the production layout: the service lives in
`mcp_server/`, the immutable dataset snapshot in `public/data/mcp/snapshot.json`.

```bash
cd mcp_server
npm install
npm test            # conformance suite against the bundled snapshot
npm run start:http  # Streamable HTTP on 127.0.0.1:8788/mcp
npm start           # stdio transport
```

The service binds to loopback only; put your own reverse proxy in front for
public exposure. Options (`--snapshot`, `--port`, rate/session/body limits via
`PICKLEBALL3_MCP_*` environment variables) are documented in
`mcp_server/http-server.mjs`.

## Data and affiliate disclosure

`public/data/mcp/snapshot.json` is the same snapshot the production service
serves, generated from the canonical review data of pickleball3.com. A
purchase link appears only for exact brand/model/shape/thickness matches with
`verified` affiliate status, at least one accepted price observation and an
HTTPS URL; such links are **sponsored** and include the observation date,
region and currency. Missing, unverified or price-less records expose no
purchase URL. See `affiliate_policy` in the snapshot.

## License

[MIT](LICENSE). Review content and the scoring methodology belong to
pickleball3.com; cite the `canonical_url` and `methodology_url` fields when
reusing results.
