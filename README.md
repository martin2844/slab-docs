# Slab Docs

A small, reliable, headless knowledge base for humans and AI agents. It stores hierarchical Markdown in SQLite, keeps append-only revisions, and exposes the same logic through REST and MCP Streamable HTTP.

It does not include a UI: any client can build a tree, list, search experience, editor, and breadcrumbs using the API.

## Quick start with Docker

```bash
cp .env.example .env
# Replace DOCS_API_KEY with a long, random secret.
docker compose up -d --build
```

Endpoints:

- Health: `GET http://localhost:6980/health`
- REST: `http://localhost:6980/api`
- MCP: `http://localhost:6980/mcp`

The `slab-docs-data` volume preserves `/data/slab-docs.db` when the container is recreated. Migrations run automatically on startup, and SQLite uses WAL mode for persistent databases.

## Authentication

`/api/*` and `/mcp` accept either of these headers:

```http
Authorization: Bearer <DOCS_API_KEY>
```

```http
X-API-Key: <DOCS_API_KEY>
```

`/health` is public. The process refuses to start when `DOCS_API_KEY` is empty.

## REST

All REST responses except health use `{ "data": ..., "error": null }` or `{ "data": null, "error": ... }`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/documents` | Create a document and its initial revision |
| `GET` | `/api/documents` | List and filter documents |
| `GET` | `/api/documents/:id` | Read a document |
| `PATCH` | `/api/documents/:id` | Update a document |
| `DELETE` | `/api/documents/:id` | Archive without deleting |
| `GET` | `/api/search?q=` | Search with FTS5 |
| `GET` | `/api/documents/:id/revisions` | List revisions |
| `GET` | `/api/documents/:id/revisions/:revision` | Read a revision |

List filters: `parent_id`, `tag`, `archived`, `search`, `limit`, and `offset`.

```bash
curl -X POST http://localhost:6980/api/documents \
  -H "Authorization: Bearer $DOCS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Autocorp pricing",
    "body": "# Pricing\n\nEnterprise plans.",
    "tags": ["sales", "customer"],
    "author": "Martin"
  }'

curl "http://localhost:6980/api/search?q=autocorp%20pricing" \
  -H "Authorization: Bearer $DOCS_API_KEY"
```

Explicit slugs must use lowercase letters, numbers, and hyphens. If the slug is omitted, it is generated from the title and receives a suffix when necessary. Changing the title or body creates a new revision; tag-only or hierarchy-only changes do not duplicate content in the revision history.

## MCP

The `/mcp` endpoint implements the current Streamable HTTP transport while retaining stateless compatibility with previous-generation MCP clients. Use the HTTP URL and send the API key as a Bearer token.

Available tools:

- `list_docs`
- `search_docs`
- `get_doc`
- `create_doc`
- `update_doc`
- `archive_doc`
- `list_doc_revisions`
- `get_doc_revision`

Each tool returns consistent JSON as both text content and `structuredContent`. `get_doc`, `update_doc`, `archive_doc`, and the revision tools accept exactly one of `id` or `slug`.

## Development

Requires Node.js 22 or later.

```bash
npm ci
DOCS_API_KEY=development-key DOCS_DB_PATH=./data/slab-docs.db npm run dev
```

Quality commands:

```bash
npm test
npm run test:coverage
npm run typecheck
npm run lint
npm run build
```

The suite covers utilities, validation, CRUD, hierarchy and cycle handling, slug uniqueness, archiving, revisions, FTS5, authentication, REST, all eight MCP tools, Streamable HTTP, migrations, and persistence across restarts.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `6980` | HTTP port |
| `HOST` | `0.0.0.0` | Listening interface |
| `DOCS_API_KEY` | — | Required secret |
| `DOCS_DB_PATH` | `/data/slab-docs.db` | SQLite file |
| `NODE_ENV` | `development` | Runtime environment |
