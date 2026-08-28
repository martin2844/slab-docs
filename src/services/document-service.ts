import { randomUUID } from "node:crypto";
import type { SlabDatabase } from "../db/database.js";
import type {
  Document,
  DocumentIdentifier,
  DocumentRevision,
  DocumentSummary,
  SearchResult,
} from "../domain/documents.js";
import type { DocumentAccess, DocumentCollection } from "../domain/access.js";
import {
  ADMIN_DOCUMENT_ACCESS,
  canReadCollection,
  canWriteCollection,
  WORKSPACE_COLLECTION_ID,
} from "../domain/access.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../errors.js";
import type {
  CreateDocumentInput,
  ListDocumentsInput,
  SearchDocumentsInput,
  UpdateDocumentInput,
} from "../schemas/documents.js";
import { buildFtsQuery } from "../utils/search.js";
import { slugify, slugWithSuffix } from "../utils/slug.js";
import { deserializeTags, serializeTags } from "../utils/tags.js";

interface DocumentRow extends Omit<Document, "tags"> {
  tags: string;
}

interface DocumentSummaryRow extends Omit<DocumentSummary, "tags"> {
  tags: string;
}

interface SearchResultRow extends Omit<SearchResult, "tags"> {
  tags: string;
}

interface ParentRow {
  id: string;
  parent_id: string | null;
  collection_id: string;
  archived_at: string | null;
}

type RevisionRow = DocumentRevision;

interface ServiceOptions {
  now?: () => string;
  id?: () => string;
}

type QueryValue = string | number | null;

function appendCollectionScope(
  access: DocumentAccess,
  alias: string,
  conditions: string[],
  parameters: QueryValue[],
): void {
  if (access.kind === "admin") return;
  if (access.readCollectionIds.length === 0) {
    conditions.push("1 = 0");
    return;
  }
  conditions.push(
    `${alias}.collection_id IN (${access.readCollectionIds.map(() => "?").join(", ")})`,
  );
  parameters.push(...access.readCollectionIds);
}

function mapDocument(row: DocumentRow): Document {
  return { ...row, tags: deserializeTags(row.tags) };
}

function mapDocumentSummary(row: DocumentSummaryRow): DocumentSummary {
  return { ...row, tags: deserializeTags(row.tags) };
}

function mapSearchResult(row: SearchResultRow): SearchResult {
  return { ...row, tags: deserializeTags(row.tags) };
}

function changedTags(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length !== right.length ||
    left.some((tag, index) => tag !== right[index])
  );
}

export class DocumentService {
  private readonly now: () => string;
  private readonly createId: () => string;

  public constructor(
    private readonly database: SlabDatabase,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.id ?? randomUUID;
  }

  public create(
    input: CreateDocumentInput,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): Document {
    const createDocument = this.database.transaction(() => {
      this.requireWritableCollection(input.collection_id, access);
      if (input.parent_id !== undefined && input.parent_id !== null) {
        this.validateParent(
          input.parent_id,
          undefined,
          input.collection_id,
          access,
        );
      }

      const slug = input.slug ?? this.nextAvailableSlug(slugify(input.title));
      if (input.slug !== undefined && this.slugExists(input.slug)) {
        throw new ConflictError(
          `A document with slug "${input.slug}" already exists.`,
        );
      }

      const id = this.createId();
      const timestamp = this.now();
      const author = input.author ?? "system";
      const parentId = input.parent_id ?? null;

      this.database
        .prepare(
          `INSERT INTO documents(
            id, slug, title, body, parent_id, tags, created_at, updated_at, archived_at, collection_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          id,
          slug,
          input.title,
          input.body,
          parentId,
          serializeTags(input.tags),
          timestamp,
          timestamp,
          input.collection_id,
        );

      this.insertRevision(id, 1, input.title, input.body, author, timestamp);
      return this.requireDocument({ id }, access);
    });

    try {
      return createDocument();
    } catch (error) {
      if (this.isUniqueConstraint(error)) {
        throw new ConflictError("A document with that slug already exists.");
      }
      throw error;
    }
  }

  public list(
    input: ListDocumentsInput,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): DocumentSummary[] {
    const joins: string[] = [];
    const conditions: string[] = [];
    const parameters: QueryValue[] = [];

    if (input.search !== undefined) {
      joins.push("JOIN documents_fts ON documents_fts.rowid = d.rowid");
      conditions.push("documents_fts MATCH ?");
      parameters.push(buildFtsQuery(input.search));
    }

    if (input.parent_id !== undefined) {
      if (input.parent_id === null) conditions.push("d.parent_id IS NULL");
      else {
        conditions.push("d.parent_id = ?");
        parameters.push(input.parent_id);
      }
    }

    if (input.tag !== undefined) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(d.tags) WHERE json_each.value = ? COLLATE NOCASE)",
      );
      parameters.push(input.tag);
    }

    appendCollectionScope(access, "d", conditions, parameters);

    conditions.push(
      input.archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL",
    );
    parameters.push(input.limit, input.offset);

    const order =
      input.search === undefined
        ? "d.updated_at DESC, d.title COLLATE NOCASE ASC"
        : "bm25(documents_fts) ASC, d.title COLLATE NOCASE ASC";
    const rows = this.database
      .prepare(
        `SELECT
           d.id,
           d.slug,
           d.title,
           d.parent_id,
           d.collection_id,
           d.tags,
           d.created_at,
           d.updated_at,
           d.archived_at
         FROM documents d
         ${joins.join("\n")}
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters) as DocumentSummaryRow[];

    return rows.map(mapDocumentSummary);
  }

  public search(
    input: SearchDocumentsInput,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): SearchResult[] {
    const conditions = ["documents_fts MATCH ?", "d.archived_at IS NULL"];
    const parameters: QueryValue[] = [buildFtsQuery(input.query)];
    appendCollectionScope(access, "d", conditions, parameters);
    parameters.push(input.limit);
    const rows = this.database
      .prepare(
        `SELECT
           d.id,
           d.slug,
           d.title,
           CASE
             WHEN trim(snippet(documents_fts, 1, '', '', ' … ', 24)) = ''
               THEN substr(d.body, 1, 240)
             ELSE snippet(documents_fts, 1, '', '', ' … ', 24)
           END AS excerpt,
           d.tags,
           d.collection_id,
           d.updated_at,
           -bm25(documents_fts, 8.0, 2.0, 1.0) AS score
         FROM documents_fts
         JOIN documents d ON d.rowid = documents_fts.rowid
         WHERE ${conditions.join(" AND ")}
         ORDER BY bm25(documents_fts, 8.0, 2.0, 1.0) ASC, d.updated_at DESC
         LIMIT ?`,
      )
      .all(...parameters) as SearchResultRow[];

    return rows.map(mapSearchResult);
  }

  public get(
    identifier: DocumentIdentifier,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): Document {
    return this.requireDocument(identifier, access);
  }

  public update(
    identifier: DocumentIdentifier,
    input: UpdateDocumentInput,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): Document {
    const updateDocument = this.database.transaction(() => {
      const current = this.requireDocument(identifier, access);
      this.requireWritableCollection(current.collection_id, access);
      const nextTitle = input.title ?? current.title;
      const nextBody = input.body ?? current.body;
      const nextParent =
        input.parent_id !== undefined ? input.parent_id : current.parent_id;
      const nextTags = input.tags ?? current.tags;
      const nextCollection = input.collection_id ?? current.collection_id;
      this.requireWritableCollection(nextCollection, access);

      if (nextParent !== null && nextParent !== current.parent_id) {
        this.validateParent(nextParent, current.id, nextCollection, access);
      } else if (
        nextParent !== null &&
        nextCollection !== current.collection_id
      ) {
        this.validateParent(nextParent, current.id, nextCollection, access);
      }

      const contentChanged =
        nextTitle !== current.title || nextBody !== current.body;
      const documentChanged =
        contentChanged ||
        nextParent !== current.parent_id ||
        nextCollection !== current.collection_id ||
        changedTags(nextTags, current.tags);
      if (!documentChanged) return current;

      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE documents
           SET title = ?, body = ?, parent_id = ?, tags = ?, collection_id = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          nextTitle,
          nextBody,
          nextParent,
          serializeTags(nextTags),
          nextCollection,
          timestamp,
          current.id,
        );

      if (contentChanged) {
        const revision = this.nextRevision(current.id);
        this.insertRevision(
          current.id,
          revision,
          nextTitle,
          nextBody,
          input.author ?? "system",
          timestamp,
        );
      }

      return this.requireDocument({ id: current.id }, access);
    });

    return updateDocument();
  }

  public archive(
    identifier: DocumentIdentifier,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): Document {
    const archiveDocument = this.database.transaction(() => {
      const current = this.requireDocument(identifier, access);
      this.requireWritableCollection(current.collection_id, access);
      if (current.archived_at !== null) return current;

      const timestamp = this.now();
      this.database
        .prepare(
          "UPDATE documents SET archived_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(timestamp, timestamp, current.id);
      return this.requireDocument({ id: current.id }, access);
    });

    return archiveDocument();
  }

  public listRevisions(
    identifier: DocumentIdentifier,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): DocumentRevision[] {
    const document = this.requireDocument(identifier, access);
    return this.database
      .prepare(
        `SELECT id, document_id, revision, title, body, author, created_at
         FROM document_revisions
         WHERE document_id = ?
         ORDER BY revision DESC`,
      )
      .all(document.id) as RevisionRow[];
  }

  public getRevision(
    identifier: DocumentIdentifier,
    revision: number,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): DocumentRevision {
    const document = this.requireDocument(identifier, access);
    const row = this.database
      .prepare(
        `SELECT id, document_id, revision, title, body, author, created_at
         FROM document_revisions
         WHERE document_id = ? AND revision = ?`,
      )
      .get(document.id, revision) as RevisionRow | undefined;

    if (row === undefined) {
      throw new NotFoundError(
        `Revision ${revision} was not found for document "${document.slug}".`,
      );
    }
    return row;
  }

  private nextAvailableSlug(base: string): string {
    if (!this.slugExists(base)) return base;

    for (let sequence = 2; sequence < 100_000; sequence += 1) {
      const candidate = slugWithSuffix(base, sequence);
      if (!this.slugExists(candidate)) return candidate;
    }

    throw new ConflictError(
      "Could not generate a unique slug for the document.",
    );
  }

  private slugExists(slug: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM documents WHERE slug = ?")
        .get(slug) !== undefined
    );
  }

  public ensureCollection(
    input: { id: string; name: string; kind: "workspace" | "source" },
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): DocumentCollection {
    this.requireAdmin(access);
    const timestamp = this.now();
    this.database
      .prepare(
        `INSERT INTO document_collections(id, name, kind, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           updated_at = excluded.updated_at,
           archived_at = NULL`,
      )
      .run(input.id, input.name, input.kind, timestamp, timestamp);
    return this.requireCollection(input.id);
  }

  public archiveCollection(
    collectionId: string,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): DocumentCollection {
    this.requireAdmin(access);
    if (collectionId === WORKSPACE_COLLECTION_ID) {
      throw new BadRequestError("The workspace collection cannot be archived.");
    }
    const timestamp = this.now();
    const result = this.database
      .prepare(
        "UPDATE document_collections SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
      )
      .run(timestamp, timestamp, collectionId);
    if (result.changes === 0) this.requireCollection(collectionId);
    return this.requireCollection(collectionId);
  }

  public listCollections(
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): DocumentCollection[] {
    this.requireAdmin(access);
    return this.database
      .prepare(
        `SELECT id, name, kind, created_at, updated_at, archived_at
         FROM document_collections
         ORDER BY kind, name COLLATE NOCASE`,
      )
      .all() as DocumentCollection[];
  }

  private requireDocument(
    identifier: DocumentIdentifier,
    access: DocumentAccess = ADMIN_DOCUMENT_ACCESS,
  ): Document {
    const byId = "id" in identifier && identifier.id !== undefined;
    const column = byId ? "id" : "slug";
    const value = byId ? identifier.id : identifier.slug;
    const row = this.database
      .prepare(`SELECT * FROM documents WHERE ${column} = ?`)
      .get(value) as DocumentRow | undefined;

    if (row === undefined || !canReadCollection(access, row.collection_id)) {
      throw new NotFoundError(`Document ${column} "${value}" was not found.`);
    }
    return mapDocument(row);
  }

  private validateParent(
    parentId: string,
    documentId: string | undefined,
    collectionId: string,
    access: DocumentAccess,
  ): void {
    let currentId: string | null = parentId;
    const visited = new Set<string>();

    while (currentId !== null) {
      if (currentId === documentId) {
        throw new BadRequestError(
          "A document cannot be moved below itself or one of its descendants.",
        );
      }
      if (visited.has(currentId)) {
        throw new BadRequestError("The document hierarchy contains a cycle.");
      }
      visited.add(currentId);

      const parent = this.database
        .prepare(
          "SELECT id, parent_id, collection_id, archived_at FROM documents WHERE id = ?",
        )
        .get(currentId) as ParentRow | undefined;
      if (parent === undefined)
        throw new BadRequestError(
          `Parent document "${currentId}" was not found.`,
        );
      if (!canReadCollection(access, parent.collection_id)) {
        throw new BadRequestError(
          `Parent document "${currentId}" was not found.`,
        );
      }
      if (currentId === parentId && parent.collection_id !== collectionId) {
        throw new BadRequestError(
          "A document and its parent must belong to the same collection.",
        );
      }
      if (currentId === parentId && parent.archived_at !== null) {
        throw new BadRequestError(
          "An archived document cannot be used as a parent.",
        );
      }
      currentId = parent.parent_id;
    }
  }

  private requireWritableCollection(
    collectionId: string,
    access: DocumentAccess,
  ): void {
    if (!canWriteCollection(access, collectionId)) {
      throw new ForbiddenError();
    }
    const collection = this.requireCollection(collectionId);
    if (collection.archived_at !== null) throw new ForbiddenError();
  }

  private requireCollection(collectionId: string): DocumentCollection {
    const row = this.database
      .prepare(
        "SELECT id, name, kind, created_at, updated_at, archived_at FROM document_collections WHERE id = ?",
      )
      .get(collectionId) as DocumentCollection | undefined;
    if (row === undefined)
      throw new BadRequestError(`Collection "${collectionId}" was not found.`);
    return row;
  }

  private requireAdmin(access: DocumentAccess): void {
    if (access.kind !== "admin")
      throw new ForbiddenError("Admin Docs access is required.");
  }

  private nextRevision(documentId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM document_revisions WHERE document_id = ?",
      )
      .get(documentId) as { revision: number };
    return row.revision;
  }

  private insertRevision(
    documentId: string,
    revision: number,
    title: string,
    body: string,
    author: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO document_revisions(
          id, document_id, revision, title, body, author, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.createId(),
        documentId,
        revision,
        title,
        body,
        author,
        timestamp,
      );
  }

  private isUniqueConstraint(error: unknown): boolean {
    return (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("SQLITE_CONSTRAINT_UNIQUE")
    );
  }
}
