import type { SlabDatabase } from "../db/database.js";
import { canReadCollection, type DocumentAccess } from "../domain/access.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import type { DocumentHistory, SnapshotChange } from "./document-history.js";
import type {
  DocumentSnapshot,
  RunDocumentChange,
} from "./run-change-journal.js";

export type EditingMode = "direct" | "review" | "auto";
type Session = {
  run_id: string;
  closed_at: string | null;
  editing_mode: EditingMode;
  state: string;
  author: string;
  commit_id: string | null;
  merge_error: string | null;
};
type DraftRow = {
  document_id: string;
  before_json: string | null;
  after_json: string;
};
export class DocumentDrafts {
  private overlay = false;
  private captured: SnapshotChange[] = [];
  constructor(
    private readonly db: SlabDatabase,
    private readonly history: DocumentHistory,
    private readonly now: () => string,
  ) {}
  session(runId: string) {
    return this.db
      .prepare("SELECT * FROM document_run_sessions WHERE run_id=?")
      .get(runId) as Session | undefined;
  }
  enabled(access: DocumentAccess) {
    if (this.overlay || access.kind !== "scoped" || !access.runId) return false;
    const session = this.session(access.runId);
    return (
      !!session &&
      session.editing_mode !== "direct" &&
      ["editing", "pending"].includes(session.state)
    );
  }
  capture(before: DocumentSnapshot | null, after: DocumentSnapshot) {
    if (!this.overlay) return false;
    this.captured.push({ before, after });
    return true;
  }
  private rows(runId: string) {
    return this.db
      .prepare("SELECT * FROM document_drafts WHERE run_id=? ORDER BY rowid")
      .all(runId) as DraftRow[];
  }
  private changes(runId: string): SnapshotChange[] {
    return this.rows(runId).map((row) => ({
      before: row.before_json
        ? (JSON.parse(row.before_json) as DocumentSnapshot)
        : null,
      after: JSON.parse(row.after_json) as DocumentSnapshot,
    }));
  }

  withOverlay<T>(access: DocumentAccess, operation: () => T): T {
    if (!this.enabled(access) || access.kind !== "scoped" || !access.runId)
      return operation();
    const runId = access.runId;
    // The service is synchronous. All temporary rows, FTS writes, revisions and
    // triggers are rolled back before this connection can handle another request.
    // SQLite's immediate transaction also prevents another writer from interleaving.
    return this.db
      .transaction(() => {
        this.db.exec("SAVEPOINT private_docs_overlay");
        this.overlay = true;
        this.captured = [];
        let result: T;
        let changes: SnapshotChange[];
        try {
          const drafts = this.changes(runId);
          for (const { after } of drafts) {
            const current = this.history.snapshot(after.id);
            if (
              !canReadCollection(access, after.collection_id) ||
              (current && !canReadCollection(access, current.collection_id))
            )
              throw new ForbiddenError();
            if (!current)
              this.db
                .prepare(
                  `INSERT INTO documents(id,slug,title,body,parent_id,collection_id,tags,created_at,updated_at,archived_at)
            VALUES (?,?,?,?,NULL,?,?,?,?,?)`,
                )
                .run(
                  after.id,
                  after.slug,
                  after.title,
                  after.body,
                  after.collection_id,
                  JSON.stringify(after.tags),
                  after.created_at,
                  after.updated_at,
                  after.archived_at,
                );
          }
          for (const { after } of drafts) {
            this.db
              .prepare(
                "UPDATE documents SET title=?,body=?,parent_id=?,collection_id=?,tags=?,archived_at=?,updated_at=? WHERE id=?",
              )
              .run(
                after.title,
                after.body,
                after.parent_id,
                after.collection_id,
                JSON.stringify(after.tags),
                after.archived_at,
                after.updated_at,
                after.id,
              );
            this.db
              .prepare("UPDATE documents SET mutation_version=? WHERE id=?")
              .run(after.version, after.id);
          }
          result = operation();
          changes = this.captured;
        } finally {
          this.db.exec(
            "ROLLBACK TO private_docs_overlay; RELEASE private_docs_overlay",
          );
          this.overlay = false;
          this.captured = [];
        }
        for (const { before, after } of changes)
          this.db
            .prepare(
              `INSERT INTO document_drafts(run_id,document_id,before_json,after_json) VALUES (?,?,?,?)
        ON CONFLICT(run_id,document_id) DO UPDATE SET after_json=excluded.after_json`,
            )
            .run(
              runId,
              after.id,
              before ? JSON.stringify(before) : null,
              JSON.stringify(after),
            );
        return result;
      })
      .immediate();
  }

  list(runId: string, access: DocumentAccess) {
    this.requireOwner(access);
    const session = this.session(runId);
    if (!session) throw new NotFoundError("Changeset was not found.");
    const published =
      session.state === "merged" && session.commit_id
        ? this.history.get(session.commit_id, access).changes
        : null;
    const changes: RunDocumentChange[] = (published ?? this.changes(runId)).map(
      ({ before, after }) => ({
        documentId: after.id,
        before,
        after,
        operations: [{ before, after }],
        interleaved: false,
        undoneAt: null,
        conflict: published
          ? (published.find((change) => change.documentId === after.id)
              ?.conflict ?? null)
          : this.conflict({ before, after }),
      }),
    );
    return {
      recorded: true,
      closed: !!session.closed_at,
      changes,
      editingMode: session.editing_mode,
      state: session.state,
      author: session.author,
      commitId: session.commit_id,
      mergeError: session.merge_error,
    };
  }
  pending(access: DocumentAccess) {
    this.requireOwner(access);
    return this.db
      .prepare(
        `SELECT s.*,(SELECT COUNT(*) FROM document_drafts d WHERE d.run_id=s.run_id) AS documentCount
      FROM document_run_sessions s WHERE editing_mode<>'direct' AND state='pending'
      AND EXISTS(SELECT 1 FROM document_drafts d WHERE d.run_id=s.run_id) ORDER BY closed_at DESC LIMIT 100`,
      )
      .all() as (Session & { documentCount: number })[];
  }
  private conflict({ before, after }: SnapshotChange) {
    const current = this.history.snapshot(after.id);
    if (before ? current?.version !== before.version : !!current)
      return "This document changed after the draft started. Review the newer version before merging.";
    const slug = this.db
      .prepare("SELECT id FROM documents WHERE slug=? AND id<>?")
      .get(after.slug, after.id);
    return slug ? "Another document now uses this slug." : null;
  }
  close(runId: string, successful: boolean, access: DocumentAccess) {
    this.requireOwner(access);
    return this.db
      .transaction(() => {
        const session = this.session(runId);
        if (!session || session.editing_mode === "direct")
          throw new NotFoundError("Changeset was not found.");
        if (!session.closed_at) {
          const state = this.rows(runId).length ? "pending" : "empty";
          this.db
            .prepare(
              "UPDATE document_run_sessions SET closed_at=?,state=? WHERE run_id=?",
            )
            .run(this.now(), state, runId);
          if (
            successful &&
            session.editing_mode === "auto" &&
            state === "pending"
          ) {
            try {
              this.merge(runId, access);
            } catch (error) {
              if (!(error instanceof ConflictError)) throw error;
              this.db
                .prepare(
                  "UPDATE document_run_sessions SET merge_error=? WHERE run_id=?",
                )
                .run(error.message, runId);
            }
          }
        }
        return this.list(runId, access);
      })
      .immediate();
  }
  merge(runId: string, access: DocumentAccess) {
    this.requireOwner(access);
    return this.db
      .transaction(() => {
        const session = this.session(runId);
        if (!session || session.editing_mode === "direct")
          throw new NotFoundError("Changeset was not found.");
        if (session.state === "merged") return this.list(runId, access);
        if (!session.closed_at || session.state !== "pending")
          throw new ConflictError(
            "Only a completed, pending changeset can be merged.",
          );
        const changes = this.changes(runId);
        for (const change of changes) {
          const conflict = this.conflict(change);
          if (conflict)
            throw new ConflictError(`${change.after.title}: ${conflict}`);
        }
        const applied = this.history.apply(
          changes.map(({ after }) => after),
          session.author,
        );
        const commitId = this.history.record(
          applied,
          session.author,
          `Update ${applied.length} document${applied.length === 1 ? "" : "s"}`,
          runId,
        );
        for (const change of applied)
          this.db
            .prepare(
              "INSERT INTO document_run_changes(run_id,document_id,before_json,after_json,created_at) VALUES (?,?,?,?,?)",
            )
            .run(
              runId,
              change.after.id,
              change.before ? JSON.stringify(change.before) : null,
              JSON.stringify(change.after),
              this.now(),
            );
        this.db
          .prepare(
            "UPDATE document_run_sessions SET state='merged',commit_id=?,merge_error=NULL WHERE run_id=?",
          )
          .run(commitId, runId);
        return this.list(runId, access);
      })
      .immediate();
  }
  reject(runId: string, access: DocumentAccess) {
    this.requireOwner(access);
    const session = this.session(runId);
    if (!session || session.editing_mode === "direct")
      throw new NotFoundError("Changeset was not found.");
    if (session.state === "rejected") return this.list(runId, access);
    if (!session.closed_at || session.state !== "pending")
      throw new ConflictError(
        "Only a completed, pending changeset can be rejected.",
      );
    this.db
      .prepare(
        "UPDATE document_run_sessions SET state='rejected' WHERE run_id=?",
      )
      .run(runId);
    return this.list(runId, access);
  }
  private requireOwner(access: DocumentAccess) {
    if (access.kind !== "admin")
      throw new ForbiddenError(
        "Only the owner can review or merge proposed changes.",
      );
  }
}
