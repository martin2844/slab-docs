import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestContext } from "../helpers/context.js";
import { createDocumentSchema } from "../../src/schemas/documents.js";
import {
  ADMIN_DOCUMENT_ACCESS,
  type ScopedDocumentAccess,
} from "../../src/domain/access.js";
import { AccessTokenService } from "../../src/services/access-token-service.js";
const runId = "00000000-0000-4000-8000-999999999999";
const owner = ADMIN_DOCUMENT_ACCESS;
const access: ScopedDocumentAccess = {
  kind: "scoped",
  subject: "run:example",
  runId,
  readCollectionIds: ["workspace"],
  writeCollectionIds: ["workspace"],
};

describe("Run changes", () => {
  let context: ReturnType<typeof createTestContext>;
  beforeEach(() => {
    context = createTestContext();
    context.service.runChanges.open(runId);
  });
  afterEach(() => context.database.close());
  const create = (title = "Prices", scoped = false) =>
    context.service.create(
      createDocumentSchema.parse({ title, body: "Before", tags: ["old"] }),
      scoped ? access : owner,
    );
  it("attributes signed run identity and rejects modified or unprivileged history access", () => {
    const tokens = new AccessTokenService("test-secret");
    const issued = tokens.issue({
      subject: access.subject,
      runId,
      readCollectionIds: ["workspace"],
      writeCollectionIds: ["workspace"],
    });
    const verified = tokens.verify(issued.token);
    expect(
      tokens.fromAuthInfo(tokens.toAuthInfo(issued.token, verified)),
    ).toEqual(access);
    const parts = issued.token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
    payload.runId = "00000000-0000-4000-8000-888888888888";
    parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
    expect(() => tokens.verify(parts.join("."))).toThrow(/invalid/);
    expect(() => context.service.runChanges.list(runId, access)).toThrow(
      /owner/,
    );
    expect(() =>
      context.service.runChanges.undo(runId, undefined, access),
    ).toThrow(/owner/);
  });
  it("groups repeated edits and restores content, metadata and archive state as new history", () => {
    const doc = create();
    const parent = create("Parent");
    context.service.update(
      { id: doc.id },
      {
        title: "New price",
        body: "After",
        tags: ["new"],
        parent_id: parent.id,
      },
      access,
    );
    context.service.update({ id: doc.id }, { body: "Final" }, access);
    context.service.archive({ id: doc.id }, access);
    const changes = context.service.runChanges.list(runId, owner).changes;
    expect(changes).toHaveLength(1);
    expect(changes[0]?.operations).toHaveLength(3);
    expect(changes[0]?.before).toMatchObject({
      body: "Before",
      tags: ["old"],
      parent_id: null,
      archived_at: null,
    });
    expect(changes[0]?.after.body).toBe("Final");
    expect(() =>
      context.service.runChanges.undo(runId, undefined, owner),
    ).toThrow(/Stop the run/);
    context.service.runChanges.close(runId);
    const result = context.service.runChanges.undo(runId, undefined, owner);
    expect(result.changes[0]?.undoneAt).toBeTruthy();
    expect(context.service.get({ id: doc.id })).toMatchObject({
      title: doc.title,
      body: doc.body,
      tags: doc.tags,
      parent_id: null,
      archived_at: null,
    });
    const revisions = context.service.listRevisions({ id: doc.id });
    expect(revisions[0]?.author).toBe(`Undo run ${runId}`);
    context.service.runChanges.undo(runId, undefined, owner);
    expect(context.service.listRevisions({ id: doc.id })).toHaveLength(
      revisions.length,
    );
    expect(() =>
      context.service.update({ id: doc.id }, { body: "Late" }, access),
    ).toThrow(/no longer/);
  });
  it("rejects later edits, including changes reverted back to the same text, atomically", () => {
    const a = create("A"),
      b = create("B");
    for (const doc of [a, b])
      context.service.update({ id: doc.id }, { body: "Run edit" }, access);
    context.service.update({ id: b.id }, { tags: ["outside"] });
    context.service.update({ id: b.id }, { tags: ["old"] });
    context.service.runChanges.close(runId);
    expect(() =>
      context.service.runChanges.undo(runId, undefined, owner),
    ).toThrow(/newer work/);
    expect(context.service.get({ id: a.id }).body).toBe("Run edit");
    context.service.runChanges.undo(runId, [a.id], owner);
    expect(context.service.get({ id: a.id }).body).toBe("Before");
  });
  it("marks intervening edits and preserves the exact operations instead of claiming another writer's changes", () => {
    const doc = create();
    context.service.update({ id: doc.id }, { body: "First" }, access);
    context.service.update({ id: doc.id }, { tags: ["other writer"] });
    context.service.update({ id: doc.id }, { body: "Second" }, access);
    const change = context.service.runChanges.list(runId, owner).changes[0];
    expect(change?.interleaved).toBe(true);
    expect(change?.operations[1]?.before?.tags).toEqual(["other writer"]);
    context.service.runChanges.close(runId);
    expect(() =>
      context.service.runChanges.undo(runId, undefined, owner),
    ).toThrow(/between/);
  });
  it("archives created documents on undo and respects later hierarchy dependencies", () => {
    const parent = create("Created parent", true);
    const child = context.service.create(
      createDocumentSchema.parse({
        title: "Child",
        body: "Child",
        parent_id: parent.id,
      }),
      access,
    );
    context.service.runChanges.close(runId);
    expect(() =>
      context.service.runChanges.undo(runId, [parent.id], owner),
    ).toThrow(/hierarchy/);
    context.service.runChanges.undo(runId, undefined, owner);
    expect(context.service.get({ id: parent.id }).archived_at).toBeTruthy();
    expect(context.service.get({ id: child.id }).archived_at).toBeTruthy();
  });
  it("journals within the write transaction and does not attribute no-op writes or spoofed author names", () => {
    const doc = create();
    context.service.update({ id: doc.id }, { body: "Before" }, access);
    context.service.update(
      { id: doc.id },
      { body: "Human", author: `run:${runId}` },
    );
    expect(context.service.runChanges.list(runId, owner).changes).toEqual([]);
    context.database.exec(
      "CREATE TRIGGER fail_journal BEFORE INSERT ON document_run_changes BEGIN SELECT RAISE(ABORT,'journal failure'); END",
    );
    expect(() =>
      context.service.update({ id: doc.id }, { body: "Lost audit" }, access),
    ).toThrow(/journal failure/);
    expect(context.service.get({ id: doc.id }).body).toBe("Human");
  });
});
