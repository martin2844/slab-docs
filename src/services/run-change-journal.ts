import { randomUUID } from "node:crypto";
import type { SlabDatabase } from "../db/database.js";
import type { Document } from "../domain/documents.js";
import type { DocumentAccess } from "../domain/access.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors.js";
import { DocumentHistory } from "./document-history.js";
import { DocumentDrafts, type EditingMode } from "./document-drafts.js";

export type DocumentSnapshot = Document & { version: number };
type ChangeRow = {
  sequence: number;
  document_id: string;
  before_json: string | null;
  after_json: string;
  created_at: string;
};
export type RunDocumentChange = {
  documentId: string;
  before: DocumentSnapshot | null;
  after: DocumentSnapshot;
  operations: Array<{
    before: DocumentSnapshot | null;
    after: DocumentSnapshot;
  }>;
  interleaved: boolean;
  undoneAt: string | null;
  conflict: string | null;
};

export class RunChangeJournal {
  readonly history: DocumentHistory;
  readonly drafts: DocumentDrafts;
  constructor(
    private readonly db: SlabDatabase,
    private readonly now = () => new Date().toISOString(),
  ) {
    this.history = new DocumentHistory(db, now);
    this.drafts = new DocumentDrafts(db, this.history, now);
  }

  open(runId: string, editingMode: EditingMode = "direct", author = "Agent") {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO document_run_sessions(run_id,editing_mode,author) VALUES (?,?,?)",
      )
      .run(runId, editingMode, author);
    if (this.drafts.session(runId)?.editing_mode !== editingMode)
      throw new ConflictError(
        "This run already has a different Docs editing mode.",
      );
    this.assertOpen(runId);
  }

  close(runId: string) {
    this.db
      .prepare(
        "INSERT INTO document_run_sessions(run_id,closed_at) VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET closed_at=COALESCE(closed_at,excluded.closed_at)",
      )
      .run(runId, this.now());
  }

  assertWritable(access: DocumentAccess) {
    if (access.kind === "scoped" && access.runId) this.assertOpen(access.runId);
  }

  private assertOpen(runId: string) {
    const row = this.db
      .prepare("SELECT closed_at FROM document_run_sessions WHERE run_id=?")
      .get(runId) as { closed_at: string | null } | undefined;
    if (!row || row.closed_at)
      throw new ForbiddenError("This run can no longer change Docs.");
  }

  snapshot(id: string): DocumentSnapshot {
    const row = this.db
      .prepare("SELECT * FROM documents WHERE id=?")
      .get(id) as
      | (Omit<Document, "tags"> & { tags: string; mutation_version: number })
      | undefined;
    if (!row) throw new NotFoundError("Document was not found.");
    const { mutation_version, ...document } = row;
    return {
      ...document,
      tags: JSON.parse(row.tags) as string[],
      version: mutation_version,
    };
  }

  record(
    access: DocumentAccess,
    before: DocumentSnapshot | null,
    id: string,
    author = "Owner",
    skipCommit = false,
  ) {
    if (access.kind === "scoped" && access.runId) this.assertOpen(access.runId);
    const after = this.snapshot(id);
    if (before?.version === after.version) return;
    if (this.drafts.capture(before, after)) return;
    if (!skipCommit)
      this.history.record(
        [{ before, after }],
        access.kind === "scoped" ? access.subject : author,
        `${before ? (after.archived_at && !before.archived_at ? "Archive" : "Update") : "Create"} ${after.title}`,
        access.kind === "scoped" ? access.runId : undefined,
      );
    if (access.kind !== "scoped" || !access.runId) return;
    this.db
      .prepare(
        "INSERT INTO document_run_changes(run_id,document_id,before_json,after_json,created_at) VALUES (?,?,?,?,?)",
      )
      .run(
        access.runId,
        id,
        before ? JSON.stringify(before) : null,
        JSON.stringify(after),
        this.now(),
      );
  }

  list(runId: string, access: DocumentAccess) {
    this.requireAdmin(access);
    const draft = this.drafts.session(runId);
    if (draft && draft.editing_mode !== "direct" && draft.state !== "merged")
      return this.drafts.list(runId, access);
    const session = this.db
      .prepare("SELECT closed_at FROM document_run_sessions WHERE run_id=?")
      .get(runId) as { closed_at: string | null } | undefined;
    const rows = this.db
      .prepare(
        "SELECT * FROM document_run_changes WHERE run_id=? ORDER BY sequence",
      )
      .all(runId) as ChangeRow[];
    const grouped = new Map<string, RunDocumentChange>();
    for (const row of rows) {
      const before = row.before_json
        ? (JSON.parse(row.before_json) as DocumentSnapshot)
        : null;
      const after = JSON.parse(row.after_json) as DocumentSnapshot;
      const existing = grouped.get(row.document_id);
      if (existing) {
        existing.interleaved ||= existing.after.version !== before?.version;
        existing.after = after;
        existing.operations.push({ before, after });
      } else
        grouped.set(row.document_id, {
          documentId: row.document_id,
          before,
          after,
          operations: [{ before, after }],
          interleaved: false,
          undoneAt: null,
          conflict: null,
        });
    }
    for (const change of grouped.values()) {
      const undo = this.db
        .prepare(
          "SELECT created_at FROM document_run_undos WHERE run_id=? AND document_id=?",
        )
        .get(runId, change.documentId) as { created_at: string } | undefined;
      change.undoneAt = undo?.created_at ?? null;
      if (!undo) {
        const current = this.snapshot(change.documentId);
        if (change.interleaved)
          change.conflict =
            "Another edit occurred between this run's changes. Review the individual edits before restoring.";
        else if (current.version !== change.after.version)
          change.conflict =
            "This document was edited after this run. Undo would overwrite newer work.";
      }
    }
    return {
      ...(draft && draft.editing_mode !== "direct"
        ? {
            editingMode: draft.editing_mode,
            state: draft.state,
            author: draft.author,
            commitId: draft.commit_id,
            mergeError: draft.merge_error,
          }
        : {}),
      recorded: !!session,
      closed: !!session?.closed_at,
      changes: [...grouped.values()],
    };
  }

  undo(
    runId: string,
    documentIds: string[] | undefined,
    access: DocumentAccess,
  ) {
    this.requireAdmin(access);
    return this.db
      .transaction(() => {
        const result = this.list(runId, access);
        const session = this.drafts.session(runId);
        if (
          session &&
          session.editing_mode !== "direct" &&
          session.state !== "merged"
        )
          throw new ConflictError("Only published changes can be undone.");
        if (!result.recorded)
          throw new NotFoundError("This run has no recorded Docs changes.");
        // Only the control plane can close a run. No mutation can race this
        // immediate transaction after the run's change set has been closed.
        if (!result.closed)
          throw new ConflictError("Stop the run before undoing its changes.");
        if (
          documentIds?.some(
            (id) => !result.changes.some((change) => change.documentId === id),
          )
        )
          throw new NotFoundError(
            "A selected document is not part of this run.",
          );
        const selected = result.changes.filter(
          (change) =>
            !change.undoneAt &&
            (!documentIds || documentIds.includes(change.documentId)),
        );
        for (const change of selected)
          if (change.conflict)
            throw new ConflictError(
              `${change.after.title}: ${change.conflict}`,
            );
        const stamp = this.now();
        const reverted: Array<{
          before: DocumentSnapshot;
          after: DocumentSnapshot;
        }> = [];
        const restored = new Map(
          selected.map((change) => [
            change.documentId,
            change.before ?? { ...change.after, archived_at: stamp },
          ]),
        );
        const prospective = (id: string) =>
          restored.get(id) ?? this.snapshot(id);
        // Check changed documents and their children against the entire proposed
        // result before writing, so a batch can restore a parent and child together.
        const affected = new Set(restored.keys());
        for (const id of restored.keys()) {
          const children = this.db
            .prepare("SELECT id FROM documents WHERE parent_id=?")
            .all(id) as { id: string }[];
          for (const child of children) affected.add(child.id);
        }
        for (const id of affected) {
          const document = prospective(id);
          if (restored.has(id)) {
            const collection = this.db
              .prepare(
                "SELECT archived_at FROM document_collections WHERE id=?",
              )
              .get(document.collection_id) as
              { archived_at: string | null } | undefined;
            if (!collection || collection.archived_at)
              throw new ConflictError(
                "A document's original collection is no longer available.",
              );
          }
          if (document.archived_at) continue;
          const visited = new Set([id]);
          let child = document;
          while (child.parent_id) {
            if (visited.has(child.parent_id))
              throw new ConflictError(
                "Undo would create a document hierarchy cycle.",
              );
            visited.add(child.parent_id);
            const parent = prospective(child.parent_id);
            if (
              parent.archived_at ||
              parent.collection_id !== child.collection_id
            )
              throw new ConflictError(
                "Undo would affect a document that depends on the current hierarchy. Include its changes or resolve the dependency first.",
              );
            child = parent;
          }
        }
        for (const change of selected) {
          const target = restored.get(change.documentId)!;
          const before = this.snapshot(change.documentId);
          this.db
            .prepare(
              `UPDATE documents SET title=?,body=?,parent_id=?,collection_id=?,tags=?,archived_at=?,updated_at=? WHERE id=?`,
            )
            .run(
              target.title,
              target.body,
              target.parent_id,
              target.collection_id,
              JSON.stringify(target.tags),
              target.archived_at,
              stamp,
              change.documentId,
            );
          const after = this.snapshot(change.documentId);
          reverted.push({ before, after });
          this.db
            .prepare(
              `INSERT INTO document_revisions(id,document_id,revision,title,body,author,created_at)
          VALUES (?,?,(SELECT COALESCE(MAX(revision),0)+1 FROM document_revisions WHERE document_id=?),?,?,?,?)`,
            )
            .run(
              randomUUID(),
              change.documentId,
              change.documentId,
              after.title,
              after.body,
              `Undo run ${runId}`,
              stamp,
            );
          this.db
            .prepare(
              "INSERT INTO document_run_undos(run_id,document_id,before_json,after_json,created_at) VALUES (?,?,?,?,?)",
            )
            .run(
              runId,
              change.documentId,
              JSON.stringify(before),
              JSON.stringify(after),
              stamp,
            );
        }
        this.history.record(reverted, "Owner", `Undo run ${runId}`, undefined);
        return this.list(runId, access);
      })
      .immediate();
  }

  private requireAdmin(access: DocumentAccess) {
    if (access.kind !== "admin")
      throw new ForbiddenError(
        "Only the owner can review or undo run changes.",
      );
  }
}
