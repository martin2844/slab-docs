# Slab Docs

## 1. Resumen

Slab Docs es un microservicio headless de documentación diseñado para humanos y agentes de IA.

Debe cumplir para conocimiento organizacional el mismo rol que Slab cumple para work tracking:

* simple;
* headless;
* API-first;
* MCP-first;
* self-hostable;
* fácil de operar;
* sin UI propia;
* sin dependencias externas complejas.

La UI de lectura y edición será responsabilidad de aplicaciones consumidoras, inicialmente el Slab Next.js App.

Slab Docs almacena documentos Markdown jerárquicos, mantiene historial de revisiones y permite búsquedas.

---

# 2. Problema

Los agentes necesitan una fuente persistente y verificable de conocimiento sobre la empresa.

Ese conocimiento no debe vivir:

* dentro de system prompts;
* únicamente en conversaciones;
* en memoria implícita del modelo;
* duplicado dentro de cada agente.

Necesitamos un servicio dedicado que permita:

* leer conocimiento;
* buscar conocimiento;
* escribir conocimiento;
* editarlo;
* versionarlo;
* consumirlo desde humanos mediante HTTP;
* consumirlo desde agentes mediante MCP.

---

# 3. Objetivo del MVP

Poder desplegar Slab Docs en un servidor mediante Docker y utilizarlo inmediatamente como servidor de conocimiento desde cualquier cliente MCP.

Ejemplo conceptual:

```text
Codex
  |
    | MCP
      v
      Slab Docs

      search_docs("Autocorp")
      get_doc(...)
      update_doc(...)
      ```

      Al mismo tiempo una aplicación tradicional debe poder consumir exactamente la misma información mediante REST.

      ---

# 4. Stack

* Node.js
* TypeScript
* Express.js 5
* SQLite
* `better-sqlite3`
* Zod para validación
* MCP TypeScript SDK
* SQLite FTS5 para búsqueda
* Docker
* Docker Compose para desarrollo/deployment de referencia

No utilizar:

* PostgreSQL;
* Redis;
* Elasticsearch;
* vector database;
* ORM complejo;
* servicios externos obligatorios.

---

# 5. Arquitectura

Un único proceso Express expone:

```text
:6980

/health
/api/*
/mcp
```

REST y MCP comparten:

* services;
* schemas;
* database;
* authorization;
* business logic.

Ninguna lógica de negocio debe duplicarse entre REST y MCP.

```text
REST ──────┐
           │
                      v
                             Services
                                        │
                                                   v
                                                           SQLite
                                                                      ^
                                                                                 │
                                                                                 MCP ───────┘
                                                                                 ```

                                                                                 ---

# 6. Persistencia

La base debe encontrarse dentro de:

```text
/data/slab-docs.db
```

Configurable mediante:

```text
DOCS_DB_PATH=/data/slab-docs.db
```

Docker debe montar `/data` como volumen persistente.

Ejemplo conceptual:

```text
slab-docs-data:/data
```

Eliminar o recrear el container no debe eliminar documentos.

Las migraciones se ejecutan automáticamente al iniciar el servicio.

SQLite debe utilizar WAL cuando sea apropiado.

---

# 7. Modelo de datos

## `documents`

Campos mínimos:

```text
id
slug
title
body
parent_id
tags
created_at
updated_at
archived_at
```

### `id`

UUID o identificador equivalente generado por el servidor.

### `slug`

Identificador humano único.

Ejemplo:

```text
autocorp-integration
api-pricing
monitoring-product
```

### `body`

Markdown.

El servicio no almacena HTML generado como source of truth.

### `parent_id`

Permite jerarquía:

```text
Clasificar
├── Product
│   ├── Monitoring
│   └── Reports
└── Sales
    ├── Autocorp
        └── Pricing
        ```

        Debe ser nullable para documentos raíz.

### `tags`

Array JSON simple.

Ejemplo:

```json
["sales", "b2b", "customer"]
```

---

## `document_revisions`

Cada modificación del contenido o título crea una revisión.

Campos:

```text
id
document_id
revision
title
body
author
created_at
```

Las revisiones son append-only.

El MVP no necesita restauración automática, pero sí debe permitir leer versiones anteriores.

---

# 8. REST API

Todas las respuestas siguen una estructura consistente:

```json
{
      "data": {},
        "error": null
}
```

## Documents

```text
POST   /api/documents
GET    /api/documents
GET    /api/documents/:id
PATCH  /api/documents/:id
DELETE /api/documents/:id
```

`DELETE` debe archivar por defecto y no eliminar físicamente.

Filtros de listado:

```text
parent_id
tag
archived
search
limit
offset
```

---

## Search

```text
GET /api/search?q=
```

Debe buscar como mínimo en:

* title;
* body;
* tags.

Usar SQLite FTS5.

Los resultados deben devolver:

```text
id
slug
title
excerpt
updated_at
score
```

---

## Revisions

```text
GET /api/documents/:id/revisions
GET /api/documents/:id/revisions/:revision
```

---

# 9. MCP

Endpoint:

```text
POST /mcp
```

Utilizar MCP Streamable HTTP.

Herramientas mínimas:

## `list_docs`

Permite listar documentos.

Argumentos opcionales:

```text
parent_id
tag
archived
limit
offset
```

---

## `search_docs`

Argumentos:

```text
query
limit?
```

Devuelve resultados relevantes con excerpt.

---

## `get_doc`

Argumentos:

```text
id | slug
```

Devuelve el documento completo.

---

## `create_doc`

Argumentos:

```text
title
slug?
body
parent_id?
tags?
author?
```

---

## `update_doc`

Argumentos:

```text
id | slug
title?
body?
parent_id?
tags?
author?
```

Debe crear automáticamente una revisión cuando corresponda.

---

## `archive_doc`

Argumentos:

```text
id | slug
```

---

## `list_doc_revisions`

Argumentos:

```text
id | slug
```

---

## `get_doc_revision`

Argumentos:

```text
id | slug
revision
```

---

# 10. Autenticación

MVP single-tenant.

Una única API key:

```text
DOCS_API_KEY
```

Debe proteger:

```text
/api/*
/mcp
```

`/health` queda público.

El mecanismo debe funcionar tanto para clientes HTTP normales como MCP remotos.

No implementar:

* usuarios;
* organizaciones;
* OAuth;
* RBAC;
* permisos por documento.

---

# 11. Docker

El repositorio debe incluir:

```text
Dockerfile
docker-compose.yml
.env.example
```

Variables:

```text
PORT=6980
DOCS_API_KEY=
DOCS_DB_PATH=/data/slab-docs.db
```

Deployment esperado:

```text
docker compose up -d
```

Debe quedar:

```text
REST: http://host:6980/api
MCP:  http://host:6980/mcp
```

---

# 12. Healthcheck

```text
GET /health
```

Respuesta:

```json
{
      "status": "ok"
}
```

Docker debe utilizar este endpoint para healthcheck.

---

# 13. Requirements de agentes

El diseño debe priorizar consumo por agentes.

Los tools MCP deben:

* tener nombres predecibles;
* aceptar argumentos pequeños;
* devolver JSON consistente;
* evitar respuestas excesivamente largas cuando no son necesarias;
* permitir buscar antes de leer documentos completos.

Un agente debería poder ejecutar:

```text
search_docs("pricing autocorp")
        ↓
        get_doc("api-pricing")
                ↓
                get_doc("autocorp")
                ```

                sin conocer previamente IDs internos.

                ---

# 14. Requirements de UI

Slab Docs NO incluye UI.

Pero su API debe permitir que otra app implemente:

* árbol de documentos;
* lista;
* búsqueda;
* creación;
* editor Markdown;
* breadcrumbs;
* historial básico.

---

# 15. Non-goals MVP

No construir:

* editor visual;
* colaboración realtime;
* comentarios;
* mentions;
* permissions;
* attachments;
* imágenes;
* embeddings;
* semantic/vector search;
* IA integrada;
* chat;
* agentes;
* automations;
* notifications;
* publicación pública;
* múltiples workspaces.

---

# 16. Testing

Tests mínimos:

* CRUD documents;
* hierarchy;
* slug uniqueness;
* archive;
* revisions;
* FTS search;
* auth;
* MCP tools;
* persistence across restart;
* migrations.

Objetivo:

la lógica de services debe poder testearse independientemente de Express y MCP.

---

# 17. Definition of Done

Slab Docs MVP está terminado cuando:

1. Puede desplegarse con Docker.
2. Los datos sobreviven recreación del container.
3. Un documento puede crearse, editarse, buscarse y archivarse por REST.
4. Las mismas operaciones pueden realizarse mediante MCP.
5. Cada modificación mantiene historial.
6. Codex puede conectarse remotamente al endpoint MCP y consultar documentos.
7. Una aplicación externa puede construir una UI completa sin acceder directamente a SQLite.

---

# 18. Principio de producto

Slab Docs no intenta ser Confluence.

Debe ser:

> una base de conocimiento pequeña, confiable y headless que humanos y agentes puedan compartir.

La complejidad visual pertenece al cliente.

La verdad documental pertenece a Slab Docs.

