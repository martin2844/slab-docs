import { randomUUID } from "node:crypto";
import type { SlabDatabase } from "../db/database.js";
import type {
  Document,
  DocumentIdentifier,
  DocumentRevision,
  SearchResult
} from "../domain/documents.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type {
  CreateDocumentInput,
  ListDocumentsInput,
  SearchDocumentsInput,
  UpdateDocumentInput
} from "../schemas/documents.js";
import { buildFtsQuery } from "../utils/search.js";
import { slugify, slugWithSuffix } from "../utils/slug.js";
import { deserializeTags, serializeTags } from "../utils/tags.js";

interface DocumentRow extends Omit<Document, "tags"> {
  tags: string;
}

interface ParentRow {
  id: string;
  parent_id: string | null;
  archived_at: string | null;
}

type RevisionRow = DocumentRevision;

interface ServiceOptions {
  now?: () => string;
  id?: () => string;
}

type QueryValue = string | number | null;

function mapDocument(row: DocumentRow): Document {
  return { ...row, tags: deserializeTags(row.tags) };
}

function changedTags(left: readonly string[], right: readonly string[]): boolean {
  return left.length !== right.length || left.some((tag, index) => tag !== right[index]);
}

export class DocumentService {
  private readonly now: () => string;
  private readonly createId: () => string;

  public constructor(
    private readonly database: SlabDatabase,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.id ?? randomUUID;
  }

  public create(input: CreateDocumentInput): Document {
    const createDocument = this.database.transaction(() => {
      if (input.parent_id !== undefined && input.parent_id !== null) {
        this.validateParent(input.parent_id);
      }

      const slug = input.slug ?? this.nextAvailableSlug(slugify(input.title));
      if (input.slug !== undefined && this.slugExists(input.slug)) {
        throw new ConflictError(`A document with slug "${input.slug}" already exists.`);
      }

      const id = this.createId();
      const timestamp = this.now();
      const author = input.author ?? "system";
      const parentId = input.parent_id ?? null;

      this.database
        .prepare(
          `INSERT INTO documents(
            id, slug, title, body, parent_id, tags, created_at, updated_at, archived_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(
          id,
          slug,
          input.title,
          input.body,
          parentId,
          serializeTags(input.tags),
          timestamp,
          timestamp
        );

      this.insertRevision(id, 1, input.title, input.body, author, timestamp);
      return this.requireDocument({ id });
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

  public list(input: ListDocumentsInput): Document[] {
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
        "EXISTS (SELECT 1 FROM json_each(d.tags) WHERE json_each.value = ? COLLATE NOCASE)"
      );
      parameters.push(input.tag);
    }

    conditions.push(input.archived ? "d.archived_at IS NOT NULL" : "d.archived_at IS NULL");
    parameters.push(input.limit, input.offset);

    const order =
      input.search === undefined
        ? "d.updated_at DESC, d.title COLLATE NOCASE ASC"
        : "bm25(documents_fts) ASC, d.title COLLATE NOCASE ASC";
    const rows = this.database
      .prepare(
        `SELECT d.*
         FROM documents d
         ${joins.join("\n")}
         WHERE ${conditions.join(" AND ")}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`
      )
      .all(...parameters) as DocumentRow[];

    return rows.map(mapDocument);
  }

  public search(input: SearchDocumentsInput): SearchResult[] {
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
           d.updated_at,
           -bm25(documents_fts, 8.0, 2.0, 1.0) AS score
         FROM documents_fts
         JOIN documents d ON d.rowid = documents_fts.rowid
         WHERE documents_fts MATCH ? AND d.archived_at IS NULL
         ORDER BY bm25(documents_fts, 8.0, 2.0, 1.0) ASC, d.updated_at DESC
         LIMIT ?`
      )
      .all(buildFtsQuery(input.query), input.limit) as SearchResult[];

    return rows;
  }

  public get(identifier: DocumentIdentifier): Document {
    return this.requireDocument(identifier);
  }

  public update(identifier: DocumentIdentifier, input: UpdateDocumentInput): Document {
    const updateDocument = this.database.transaction(() => {
      const current = this.requireDocument(identifier);
      const nextTitle = input.title ?? current.title;
      const nextBody = input.body ?? current.body;
      const nextParent = input.parent_id !== undefined ? input.parent_id : current.parent_id;
      const nextTags = input.tags ?? current.tags;

      if (nextParent !== null && nextParent !== current.parent_id) {
        this.validateParent(nextParent, current.id);
      }

      const contentChanged = nextTitle !== current.title || nextBody !== current.body;
      const documentChanged =
        contentChanged || nextParent !== current.parent_id || changedTags(nextTags, current.tags);
      if (!documentChanged) return current;

      const timestamp = this.now();
      this.database
        .prepare(
          `UPDATE documents
           SET title = ?, body = ?, parent_id = ?, tags = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(nextTitle, nextBody, nextParent, serializeTags(nextTags), timestamp, current.id);

      if (contentChanged) {
        const revision = this.nextRevision(current.id);
        this.insertRevision(
          current.id,
          revision,
          nextTitle,
          nextBody,
          input.author ?? "system",
          timestamp
        );
      }

      return this.requireDocument({ id: current.id });
    });

    return updateDocument();
  }

  public archive(identifier: DocumentIdentifier): Document {
    const archiveDocument = this.database.transaction(() => {
      const current = this.requireDocument(identifier);
      if (current.archived_at !== null) return current;

      const timestamp = this.now();
      this.database
        .prepare("UPDATE documents SET archived_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, current.id);
      return this.requireDocument({ id: current.id });
    });

    return archiveDocument();
  }

  public listRevisions(identifier: DocumentIdentifier): DocumentRevision[] {
    const document = this.requireDocument(identifier);
    return this.database
      .prepare(
        `SELECT id, document_id, revision, title, body, author, created_at
         FROM document_revisions
         WHERE document_id = ?
         ORDER BY revision DESC`
      )
      .all(document.id) as RevisionRow[];
  }

  public getRevision(identifier: DocumentIdentifier, revision: number): DocumentRevision {
    const document = this.requireDocument(identifier);
    const row = this.database
      .prepare(
        `SELECT id, document_id, revision, title, body, author, created_at
         FROM document_revisions
         WHERE document_id = ? AND revision = ?`
      )
      .get(document.id, revision) as RevisionRow | undefined;

    if (row === undefined) {
      throw new NotFoundError(`Revision ${revision} was not found for document "${document.slug}".`);
    }
    return row;
  }

  private nextAvailableSlug(base: string): string {
    if (!this.slugExists(base)) return base;

    for (let sequence = 2; sequence < 100_000; sequence += 1) {
      const candidate = slugWithSuffix(base, sequence);
      if (!this.slugExists(candidate)) return candidate;
    }

    throw new ConflictError("Could not generate a unique slug for the document.");
  }

  private slugExists(slug: string): boolean {
    return this.database.prepare("SELECT 1 FROM documents WHERE slug = ?").get(slug) !== undefined;
  }

  private requireDocument(identifier: DocumentIdentifier): Document {
    const byId = "id" in identifier && identifier.id !== undefined;
    const column = byId ? "id" : "slug";
    const value = byId ? identifier.id : identifier.slug;
    const row = this.database
      .prepare(`SELECT * FROM documents WHERE ${column} = ?`)
      .get(value) as DocumentRow | undefined;

    if (row === undefined) {
      throw new NotFoundError(`Document ${column} "${value}" was not found.`);
    }
    return mapDocument(row);
  }

  private validateParent(parentId: string, documentId?: string): void {
    let currentId: string | null = parentId;
    const visited = new Set<string>();

    while (currentId !== null) {
      if (currentId === documentId) {
        throw new BadRequestError("A document cannot be moved below itself or one of its descendants.");
      }
      if (visited.has(currentId)) {
        throw new BadRequestError("The document hierarchy contains a cycle.");
      }
      visited.add(currentId);

      const parent = this.database
        .prepare("SELECT id, parent_id, archived_at FROM documents WHERE id = ?")
        .get(currentId) as ParentRow | undefined;
      if (parent === undefined) throw new BadRequestError(`Parent document "${currentId}" was not found.`);
      if (currentId === parentId && parent.archived_at !== null) {
        throw new BadRequestError("An archived document cannot be used as a parent.");
      }
      currentId = parent.parent_id;
    }
  }

  private nextRevision(documentId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM document_revisions WHERE document_id = ?"
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
    timestamp: string
  ): void {
    this.database
      .prepare(
        `INSERT INTO document_revisions(
          id, document_id, revision, title, body, author, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.createId(), documentId, revision, title, body, author, timestamp);
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
