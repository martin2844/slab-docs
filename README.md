# Slab Docs

Una base de conocimiento pequeña, confiable y headless para humanos y agentes de IA. Guarda Markdown jerárquico en SQLite, mantiene revisiones append-only y expone la misma lógica por REST y MCP Streamable HTTP.

No incluye UI: cualquier cliente puede construir árbol, lista, búsqueda, editor y breadcrumbs usando la API.

## Inicio rápido con Docker

```bash
cp .env.example .env
# Reemplazar DOCS_API_KEY por un secreto largo y aleatorio.
docker compose up -d --build
```

Endpoints:

- Health: `GET http://localhost:6980/health`
- REST: `http://localhost:6980/api`
- MCP: `http://localhost:6980/mcp`

El volumen `slab-docs-data` conserva `/data/slab-docs.db` aunque el container sea recreado. Las migraciones se ejecutan automáticamente al iniciar y SQLite usa WAL en bases persistentes.

## Autenticación

`/api/*` y `/mcp` aceptan cualquiera de estos headers:

```http
Authorization: Bearer <DOCS_API_KEY>
```

```http
X-API-Key: <DOCS_API_KEY>
```

`/health` es público. El proceso se niega a iniciar si `DOCS_API_KEY` está vacío.

## REST

Todas las respuestas REST, salvo health, usan `{ "data": ..., "error": null }` o `{ "data": null, "error": ... }`.

| Método | Ruta | Uso |
| --- | --- | --- |
| `POST` | `/api/documents` | Crear documento y revisión inicial |
| `GET` | `/api/documents` | Listar y filtrar documentos |
| `GET` | `/api/documents/:id` | Leer documento |
| `PATCH` | `/api/documents/:id` | Actualizar documento |
| `DELETE` | `/api/documents/:id` | Archivar sin borrar |
| `GET` | `/api/search?q=` | Buscar por FTS5 |
| `GET` | `/api/documents/:id/revisions` | Listar revisiones |
| `GET` | `/api/documents/:id/revisions/:revision` | Leer una revisión |

Filtros de listado: `parent_id`, `tag`, `archived`, `search`, `limit` y `offset`.

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

Los slugs explícitos deben usar minúsculas, números y guiones. Si se omite el slug, se genera desde el título y se agrega un sufijo cuando sea necesario. Un cambio de título o body crea una nueva revisión; cambios solo de tags o jerarquía no duplican contenido en el historial.

## MCP

El endpoint `/mcp` implementa Streamable HTTP actual y mantiene compatibilidad stateless con clientes MCP de la generación anterior. Usar la URL HTTP y enviar la API key como Bearer token.

Tools disponibles:

- `list_docs`
- `search_docs`
- `get_doc`
- `create_doc`
- `update_doc`
- `archive_doc`
- `list_doc_revisions`
- `get_doc_revision`

Cada tool devuelve JSON consistente tanto como contenido de texto como en `structuredContent`. `get_doc`, `update_doc`, `archive_doc` y los tools de revisiones aceptan exactamente uno de `id` o `slug`.

## Desarrollo

Requiere Node.js 22 o superior.

```bash
npm ci
DOCS_API_KEY=development-key DOCS_DB_PATH=./data/slab-docs.db npm run dev
```

Comandos de calidad:

```bash
npm test
npm run test:coverage
npm run typecheck
npm run lint
npm run build
```

La suite cubre utilidades, validación, CRUD, jerarquía y ciclos, unicidad de slug, archivo, revisiones, FTS5, autenticación, REST, los ocho tools MCP, Streamable HTTP, migraciones y persistencia entre reinicios.

## Variables de entorno

| Variable | Default | Descripción |
| --- | --- | --- |
| `PORT` | `6980` | Puerto HTTP |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `DOCS_API_KEY` | — | Secreto obligatorio |
| `DOCS_DB_PATH` | `/data/slab-docs.db` | Archivo SQLite |
| `NODE_ENV` | `development` | Entorno de ejecución |
