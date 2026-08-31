import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  Document,
  DocumentIdentifier,
  DocumentMutationResult,
} from "../domain/documents.js";
import type { DocumentAccess } from "../domain/access.js";
import { ADMIN_DOCUMENT_ACCESS } from "../domain/access.js";
import { AppError, toPublicError } from "../errors.js";
import {
  createDocumentSchema,
  collectionIdSchema,
  documentIdSchema,
  listDocumentsSchema,
  revisionNumberSchema,
  searchDocumentsSchema,
  slugSchema,
  updateDocumentSchema,
} from "../schemas/documents.js";
import type { DocumentService } from "../services/document-service.js";

const identifierSchema = z
  .object({
    id: documentIdSchema.optional(),
    slug: slugSchema.optional(),
  })
  .strict()
  .refine(({ id, slug }) => (id === undefined) !== (slug === undefined), {
    message: "Provide exactly one of id or slug.",
  });

const listDocsSchema = listDocumentsSchema.omit({ search: true });
const updateDocSchema = z.intersection(identifierSchema, updateDocumentSchema);
const revisionSchema = z.intersection(
  identifierSchema,
  z.object({ revision: revisionNumberSchema }).strict(),
);

function identifier(
  input: z.infer<typeof identifierSchema>,
): DocumentIdentifier {
  return input.id === undefined
    ? { slug: input.slug as string }
    : { id: input.id };
}

function toolSuccess(data: unknown): CallToolResult {
  const payload = { data, error: null };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function toolFailure(error: unknown): CallToolResult {
  const publicError =
    error instanceof AppError
      ? toPublicError(error)
      : {
          code: "internal_error" as const,
          message: "An unexpected error occurred.",
        };
  const payload = { data: null, error: publicError };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function mutationResult(
  document: Document,
  changedFields: string[],
): DocumentMutationResult {
  const { body, ...summary } = document;
  void body;
  return { ...summary, changed_fields: changedFields };
}

function runTool(operation: () => unknown): CallToolResult {
  try {
    return toolSuccess(operation());
  } catch (error) {
    return toolFailure(error);
  }
}

export function createMcpServer(
  service: DocumentService,
  access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
): McpServer {
  const server = new McpServer(
    { name: "slab-docs", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_docs",
    {
      title: "List documents",
      description:
        "List document metadata with optional collection, hierarchy, tag, archive, and pagination filters. Does not return document bodies. Use search_docs to discover relevant documents and get_doc to read one complete document.",
      inputSchema: listDocsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => runTool(() => service.list(input, access)),
  );

  server.registerTool(
    "search_docs",
    {
      title: "Search documents",
      description:
        "Search active document titles, Markdown bodies, and tags, optionally within one collection. Returns metadata, a short excerpt, and relevance score; use get_doc to read one complete document.",
      inputSchema: searchDocumentsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => runTool(() => service.search(input, access)),
  );

  server.registerTool(
    "get_doc",
    {
      title: "Get document",
      description:
        "Read one complete document by internal id or human-readable slug.",
      inputSchema: identifierSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => runTool(() => service.get(identifier(input), access)),
  );

  server.registerTool(
    "create_doc",
    {
      title: "Create document",
      description: "Create a Markdown document and its initial revision.",
      inputSchema: createDocumentSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool(() =>
        mutationResult(service.create(input, access), [
          "title",
          "body",
          "parent_id",
          "collection_id",
          "tags",
        ]),
      ),
  );

  server.registerTool(
    "update_doc",
    {
      title: "Update document",
      description:
        "Update a document by id or slug; title or body changes create a revision.",
      inputSchema: updateDocSchema,
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) => {
      const { id, slug, ...update } = input;
      return runTool(() =>
        mutationResult(
          service.update(identifier({ id, slug }), update, access),
          Object.keys(update).filter((field) => field !== "author"),
        ),
      );
    },
  );

  server.registerTool(
    "archive_doc",
    {
      title: "Archive document",
      description:
        "Soft-delete a document by id or slug. The document and revisions remain stored.",
      inputSchema: identifierSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input) =>
      runTool(() =>
        mutationResult(service.archive(identifier(input), access), [
          "archived_at",
        ]),
      ),
  );

  server.registerTool(
    "list_doc_revisions",
    {
      title: "List document revisions",
      description:
        "List append-only revision snapshots for a document by id or slug.",
      inputSchema: identifierSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => runTool(() => service.listRevisions(identifier(input), access)),
  );

  server.registerTool(
    "get_doc_revision",
    {
      title: "Get document revision",
      description: "Read one historical document revision by revision number.",
      inputSchema: revisionSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => {
      const { revision, ...documentIdentifier } = input;
      return runTool(() =>
        service.getRevision(identifier(documentIdentifier), revision, access),
      );
    },
  );

  if (access.kind === "admin") {
    server.registerTool(
      "ensure_collection",
      {
        title: "Ensure document collection",
        description: "Create or update a server-managed document collection.",
        inputSchema: z
          .object({
            id: collectionIdSchema,
            name: z.string().trim().min(1).max(200),
            kind: z.enum(["workspace", "source"]),
          })
          .strict(),
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input) => runTool(() => service.ensureCollection(input, access)),
    );

    server.registerTool(
      "archive_collection",
      {
        title: "Archive document collection",
        description:
          "Archive a server-managed document collection without deleting its documents.",
        inputSchema: z.object({ id: collectionIdSchema }).strict(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input) => runTool(() => service.archiveCollection(input.id, access)),
    );
  }

  return server;
}
