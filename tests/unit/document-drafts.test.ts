import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../helpers/context.js";
import { DocumentService } from "../../src/services/document-service.js";
import {
  createDocumentSchema,
  listDocumentsSchema,
  searchDocumentsSchema,
} from "../../src/schemas/documents.js";
import {
  ADMIN_DOCUMENT_ACCESS as owner,
  type ScopedDocumentAccess,
} from "../../src/domain/access.js";
const runId = "00000000-0000-4000-8000-999999999999";
const access: ScopedDocumentAccess = {
  kind: "scoped",
  subject: "Vera",
  runId,
  readCollectionIds: ["workspace"],
  writeCollectionIds: ["workspace"],
};
describe("Private drafts and commits", () => {
  let c: ReturnType<typeof createTestContext>;
  beforeEach(() => {
    c = createTestContext();
  });
  afterEach(() => c.database.close());
  const create = (
    title = "Prices",
    body = "Published",
    scope = owner as typeof owner | ScopedDocumentAccess,
    parent_id?: string,
  ) =>
    c.service.create(
      createDocumentSchema.parse({ title, body, parent_id }),
      scope,
    );
  const open = (mode: "auto" | "review" = "review") =>
    c.service.runChanges.open(runId, mode, "Vera");
  const close = (successful = true) =>
    c.service.runChanges.drafts.close(runId, successful, owner);
  it("isolates draft reads, search, lists and revisions, persists edits across service restarts, then merges one commit", () => {
    const first = create();
    const second = create("Terms");
    open();
    c.service.update({ id: first.id }, { body: "Secretdraft" }, access);
    c.service.update(
      { id: second.id },
      { title: "New terms", tags: ["draft"] },
      access,
    );
    c.service = new DocumentService(c.database);
    expect(c.service.get({ id: first.id }).body).toBe("Published");
    expect(c.service.get({ id: first.id }, access).body).toBe("Secretdraft");
    expect(
      c.service.search(searchDocumentsSchema.parse({ query: "Secretdraft" })),
    ).toEqual([]);
    expect(
      c.service.search(
        searchDocumentsSchema.parse({ query: "Secretdraft" }),
        access,
      ),
    ).toHaveLength(1);
    expect(
      c.service
        .list(listDocumentsSchema.parse({}), access)
        .find((d) => d.id === second.id)?.title,
    ).toBe("New terms");
    expect(c.service.listRevisions({ id: first.id })).toHaveLength(1);
    expect(c.service.runChanges.history.list(owner)).toHaveLength(2);
    expect(close().state).toBe("pending");
    expect(() =>
      c.service.update({ id: first.id }, { body: "Late" }, access),
    ).toThrow(/no longer/);
    c.service.runChanges.drafts.merge(runId, owner);
    expect(c.service.get({ id: first.id }).body).toBe("Secretdraft");
    const commits = c.service.runChanges.history.list(owner);
    expect(commits).toHaveLength(3);
    expect(commits[0]).toMatchObject({
      author: "Vera",
      run_id: runId,
      documentCount: 2,
    });
    c.service.runChanges.drafts.merge(runId, owner);
    expect(c.service.runChanges.history.list(owner)).toHaveLength(3);
    expect(
      c.service.runChanges.list(runId, owner).changes.every((d) => !d.conflict),
    ).toBe(true);
    c.database.exec(
      "INSERT INTO documents_fts(documents_fts,rank) VALUES ('integrity-check',1)",
    );
  });
  it("creates a private parent and child and publishes them together", () => {
    open();
    const parent = create("Parent", "Draft", access);
    const child = create("Child", "Draft", access, parent.id);
    expect(c.service.list(listDocumentsSchema.parse({}))).toEqual([]);
    expect(() => c.service.get({ id: child.id })).toThrow(/not found/);
    c.service.update({ id: child.id }, { body: "Updated child" }, access);
    close();
    c.service.runChanges.drafts.merge(runId, owner);
    expect(c.service.get({ id: child.id })).toMatchObject({
      parent_id: parent.id,
      body: "Updated child",
    });
    expect(c.database.pragma("foreign_key_check")).toEqual([]);
  });
  it("blocks review by scoped tokens and keeps denied collections read only", () => {
    const doc = create();
    open();
    expect(() =>
      c.service.update(
        { id: doc.id },
        { body: "Forbidden" },
        { ...access, writeCollectionIds: [] },
      ),
    ).toThrow();
    expect(() => c.service.runChanges.drafts.merge(runId, access)).toThrow(
      /owner/,
    );
    expect(() =>
      c.service.runChanges.drafts.close(runId, true, access),
    ).toThrow(/owner/);
    expect(() => c.service.runChanges.drafts.pending(access)).toThrow(/owner/);
    expect(() => c.service.runChanges.drafts.reject(runId, access)).toThrow(
      /owner/,
    );
    expect(c.service.runChanges.list(runId, owner).changes).toHaveLength(0);
  });
  it("publishes successful automatic runs and preserves failed or cancelled drafts for review", () => {
    const doc = create();
    open("auto");
    c.service.update({ id: doc.id }, { body: "Automatic" }, access);
    expect(close().state).toBe("merged");
    expect(c.service.get({ id: doc.id }).body).toBe("Automatic");
    expect(close(false).state).toBe("merged");
    const other = "00000000-0000-4000-8000-888888888888";
    c.service.runChanges.open(other, "auto");
    c.service.update(
      { id: doc.id },
      { body: "Incomplete" },
      { ...access, runId: other },
    );
    expect(c.service.runChanges.drafts.close(other, false, owner).state).toBe(
      "pending",
    );
    expect(c.service.get({ id: doc.id }).body).toBe("Automatic");
    c.service.runChanges.drafts.reject(other, owner);
    expect(() => c.service.runChanges.drafts.merge(other, owner)).toThrow(
      /pending/,
    );
    expect(c.service.runChanges.drafts.pending(owner)).toEqual([]);
  });
  it("rejects concurrent edits atomically, including ABA, without leaving an automatic run open", () => {
    const a = create();
    const b = create("Terms");
    open("auto");
    c.service.update({ id: a.id }, { body: "Draft A" }, access);
    c.service.update({ id: b.id }, { body: "Draft B" }, access);
    c.service.update({ id: b.id }, { body: "Intervening" });
    c.service.update({ id: b.id }, { body: "Published" });
    expect(close()).toMatchObject({
      state: "pending",
      closed: true,
      mergeError: expect.stringContaining("changed"),
    });
    expect(c.service.get({ id: a.id }).body).toBe("Published");
    expect(() => c.service.runChanges.drafts.merge(runId, owner)).toThrow(
      /changed/,
    );
    expect(c.service.runChanges.history.list(owner)).toHaveLength(4);
  });
  it("rejects slug collisions and hierarchy dependencies before publishing any document", () => {
    open();
    create("Collision", "Draft", access);
    create("Collision");
    close();
    expect(() => c.service.runChanges.drafts.merge(runId, owner)).toThrow(
      /slug/,
    );
    expect(c.service.list(listDocumentsSchema.parse({}))).toHaveLength(1);
  });
  it("preflights parent dependencies and unavailable collections before an automatic merge", () => {
    const parent = create("Parent");
    create("Existing child", "Published", owner, parent.id);
    open("auto");
    c.service.archive({ id: parent.id }, access);
    expect(close()).toMatchObject({
      state: "pending",
      mergeError: expect.stringContaining("parent"),
    });
    expect(c.service.get({ id: parent.id }).archived_at).toBeNull();
  });
  it("rolls back staged operations on failure, including draft persistence failure", () => {
    const doc = create();
    open();
    c.database.exec(
      "CREATE TRIGGER fail_draft BEFORE INSERT ON document_drafts BEGIN SELECT RAISE(ABORT,'draft persistence failed'); END",
    );
    expect(() =>
      c.service.update({ id: doc.id }, { body: "Leaked" }, access),
    ).toThrow(/persistence/);
    expect(c.service.get({ id: doc.id }).body).toBe("Published");
    expect(c.service.runChanges.history.list(owner)).toHaveLength(1);
    expect(c.service.runChanges.list(runId, owner).changes).toEqual([]);
  });
  it("records human metadata edits, avoids no-op commits, and reverts as a new commit", () => {
    const doc = create();
    c.service.update({ id: doc.id }, { tags: ["new"], author: "Martin" });
    c.service.update({ id: doc.id }, { tags: ["new"] });
    const commits = c.service.runChanges.history.list(owner);
    expect(commits).toHaveLength(2);
    expect(commits[0]?.author).toBe("Martin");
    c.service.revertCommit(commits[0]!.id);
    expect(c.service.get({ id: doc.id }).tags).toEqual([]);
    expect(c.service.runChanges.history.list(owner)).toHaveLength(3);
    expect(() => c.service.revertCommit(commits[0]!.id)).toThrow(/newer/);
  });
  it("lets agents stage a revert without publishing it or exposing private collection history", () => {
    const doc = create();
    c.service.update({ id: doc.id }, { body: "Changed" });
    const commit = c.service.runChanges.history.list(owner)[0]!;
    open();
    c.service.revertCommit(commit.id, access);
    expect(c.service.get({ id: doc.id }).body).toBe("Changed");
    expect(c.service.get({ id: doc.id }, access).body).toBe("Published");
    expect(
      c.service.runChanges.history.list({ ...access, readCollectionIds: [] }),
    ).toEqual([]);
    expect(() =>
      c.service.runChanges.history.get(commit.id, {
        ...access,
        readCollectionIds: [],
      }),
    ).toThrow(/not found/);
    close();
    c.service.runChanges.drafts.merge(runId, owner);
    expect(c.service.get({ id: doc.id }).body).toBe("Published");
  });
});
