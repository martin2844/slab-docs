import { randomUUID } from "node:crypto";
import type { SlabDatabase } from "../db/database.js";
import type { DocumentSnapshot } from "./run-change-journal.js";
import {
  canReadCollection,
  canWriteCollection,
  type DocumentAccess,
} from "../domain/access.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";

export type SnapshotChange = {
  before: DocumentSnapshot | null;
  after: DocumentSnapshot;
};
type CommitRow = {
  id: string;
  run_id: string | null;
  author: string;
  message: string;
  created_at: string;
  reverts_id: string | null;
};
export class DocumentHistory {
  constructor(
    private readonly db: SlabDatabase,
    private readonly now: () => string,
  ) {}

  snapshot(id: string): DocumentSnapshot | null {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(id) as
      | (Omit<DocumentSnapshot, "tags" | "version"> & {
          tags: string;
          mutation_version: number;
        })
      | undefined;
    if (!row) return null;
    const { mutation_version, ...doc } = row;
    return {
      ...doc,
      tags: JSON.parse(row.tags) as string[],
      version: mutation_version,
    };
  }

  record(
    changes: SnapshotChange[],
    author: string,
    message: string,
    runId?: string,
    revertsId?: string,
  ) {
    if (!changes.length) return null;
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO document_commits(id,run_id,author,message,created_at,reverts_id) VALUES (?,?,?,?,?,?)",
      )
      .run(id, runId ?? null, author, message, this.now(), revertsId ?? null);
    for (const change of changes)
      this.db
        .prepare(
          "INSERT INTO document_commit_changes(commit_id,document_id,before_json,after_json) VALUES (?,?,?,?)",
        )
        .run(
          id,
          change.after.id,
          change.before ? JSON.stringify(change.before) : null,
          JSON.stringify(change.after),
        );
    return id;
  }

  list(access: DocumentAccess, documentId?: string, offset = 0) {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];
    if (documentId) {
      conditions.push(
        "EXISTS (SELECT 1 FROM document_commit_changes d WHERE d.commit_id=c.id AND d.document_id=?)",
      );
      parameters.push(documentId);
    }
    if (access.kind === "scoped") {
      if (!access.readCollectionIds.length) return [];
      const placeholders = access.readCollectionIds.map(() => "?").join(",");
      conditions.push(`NOT EXISTS (SELECT 1 FROM document_commit_changes d JOIN documents live ON live.id=d.document_id WHERE d.commit_id=c.id AND
        (json_extract(d.after_json,'$.collection_id') NOT IN (${placeholders}) OR
        (d.before_json IS NOT NULL AND json_extract(d.before_json,'$.collection_id') NOT IN (${placeholders})) OR live.collection_id NOT IN (${placeholders})))`);
      parameters.push(
        ...access.readCollectionIds,
        ...access.readCollectionIds,
        ...access.readCollectionIds,
      );
    }
    return this.db
      .prepare(
        `SELECT id,run_id,author,message,created_at,reverts_id,
      (SELECT COUNT(*) FROM document_commit_changes d WHERE d.commit_id=c.id) AS documentCount FROM document_commits c
      ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""} ORDER BY sequence DESC LIMIT 50 OFFSET ?`,
      )
      .all(...parameters, offset) as (CommitRow & { documentCount: number })[];
  }

  get(id: string, access: DocumentAccess) {
    const row = this.db
      .prepare(
        "SELECT id,run_id,author,message,created_at,reverts_id FROM document_commits WHERE id=?",
      )
      .get(id) as CommitRow | undefined;
    const changes = this.changes(id);
    if (!row || !this.visible(changes, access))
      throw new NotFoundError("Commit was not found.");
    return {
      ...row,
      changes: changes.map((change) => ({
        ...change,
        documentId: change.after.id,
        conflict:
          this.snapshot(change.after.id)?.version !== change.after.version
            ? "This document has newer changes. Reverting would overwrite them."
            : null,
      })),
    };
  }

  private changes(id: string): SnapshotChange[] {
    return (
      this.db
        .prepare(
          "SELECT before_json,after_json FROM document_commit_changes WHERE commit_id=? ORDER BY document_id",
        )
        .all(id) as { before_json: string | null; after_json: string }[]
    ).map((row) => ({
      before: row.before_json
        ? (JSON.parse(row.before_json) as DocumentSnapshot)
        : null,
      after: JSON.parse(row.after_json) as DocumentSnapshot,
    }));
  }

  private visible(changes: SnapshotChange[], access: DocumentAccess) {
    return (
      changes.length > 0 &&
      changes.every(
        ({ before, after }) =>
          canReadCollection(access, after.collection_id) &&
          (!before || canReadCollection(access, before.collection_id)) &&
          canReadCollection(
            access,
            this.snapshot(after.id)?.collection_id ?? after.collection_id,
          ),
      )
    );
  }

  validate(targets: DocumentSnapshot[]) {
    const proposed = new Map(targets.map((doc) => [doc.id, doc]));
    const get = (id: string) => proposed.get(id) ?? this.snapshot(id);
    const affected = new Set(proposed.keys());
    for (const doc of targets) {
      const collection = this.db
        .prepare("SELECT archived_at FROM document_collections WHERE id=?")
        .get(doc.collection_id) as { archived_at: string | null } | undefined;
      if (!collection || collection.archived_at)
        throw new ConflictError("A target collection is no longer available.");
      const collision = this.db
        .prepare("SELECT id FROM documents WHERE slug=? AND id<>?")
        .get(doc.slug, doc.id);
      if (
        collision ||
        targets.some((other) => other.id !== doc.id && other.slug === doc.slug)
      )
        throw new ConflictError(
          `The slug for “${doc.title}” is already in use.`,
        );
      for (const child of this.db
        .prepare("SELECT id FROM documents WHERE parent_id=?")
        .all(doc.id) as { id: string }[])
        affected.add(child.id);
    }
    for (const id of affected) {
      let child = get(id)!;
      if (child.archived_at) continue;
      const visited = new Set([id]);
      while (child.parent_id) {
        if (visited.has(child.parent_id))
          throw new ConflictError(
            "These changes would create a document hierarchy cycle.",
          );
        visited.add(child.parent_id);
        const parent = get(child.parent_id);
        if (
          !parent ||
          parent.archived_at ||
          parent.collection_id !== child.collection_id
        )
          throw new ConflictError(
            "These changes would leave a document without an active parent in its collection.",
          );
        child = parent;
      }
    }
  }

  apply(targets: DocumentSnapshot[], author: string): SnapshotChange[] {
    this.validate(targets);
    const before = new Map(
      targets.map((doc) => [doc.id, this.snapshot(doc.id)]),
    );
    // Insert parents and children without links first; establish links after all IDs exist.
    for (const doc of targets)
      if (!before.get(doc.id))
        this.db
          .prepare(
            `INSERT INTO documents(id,slug,title,body,parent_id,collection_id,tags,created_at,updated_at,archived_at)
      VALUES (?,?,?,?,NULL,?,?,?,?,?)`,
          )
          .run(
            doc.id,
            doc.slug,
            doc.title,
            doc.body,
            doc.collection_id,
            JSON.stringify(doc.tags),
            doc.created_at,
            this.now(),
            doc.archived_at,
          );
    for (const doc of targets) {
      this.db
        .prepare(
          "UPDATE documents SET title=?,body=?,parent_id=?,collection_id=?,tags=?,archived_at=?,updated_at=? WHERE id=?",
        )
        .run(
          doc.title,
          doc.body,
          doc.parent_id,
          doc.collection_id,
          JSON.stringify(doc.tags),
          doc.archived_at,
          this.now(),
          doc.id,
        );
      this.db
        .prepare(
          `INSERT INTO document_revisions(id,document_id,revision,title,body,author,created_at)
        VALUES (?,?,(SELECT COALESCE(MAX(revision),0)+1 FROM document_revisions WHERE document_id=?),?,?,?,?)`,
        )
        .run(
          randomUUID(),
          doc.id,
          doc.id,
          doc.title,
          doc.body,
          author,
          this.now(),
        );
    }
    return targets.map((doc) => ({
      before: before.get(doc.id)!,
      after: this.snapshot(doc.id)!,
    }));
  }

  revert(
    id: string,
    access: DocumentAccess,
    onChange?: (change: SnapshotChange) => void,
  ) {
    return this.db
      .transaction(() => {
        const commit = this.get(id, access);
        for (const change of commit.changes) {
          if (change.conflict) throw new ConflictError(change.conflict);
          if (
            !canWriteCollection(access, change.after.collection_id) ||
            (change.before &&
              !canWriteCollection(access, change.before.collection_id))
          )
            throw new ForbiddenError();
        }
        const author = access.kind === "admin" ? "Owner" : access.subject;
        const changes = this.apply(
          commit.changes.map(
            ({ before, after }) =>
              before ?? { ...after, archived_at: this.now() },
          ),
          author,
        );
        for (const change of changes) onChange?.(change);
        const commitId = this.record(
          changes,
          author,
          `Revert ${id.slice(0, 8)}`,
          access.kind === "scoped" ? access.runId : undefined,
          id,
        );
        return { commitId, changes };
      })
      .immediate();
  }
}
