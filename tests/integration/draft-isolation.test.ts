import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDatabase, closeDatabase } from "../../src/db/database.js";
import { DocumentService } from "../../src/services/document-service.js";
import { createDocumentSchema } from "../../src/schemas/documents.js";
import type { ScopedDocumentAccess } from "../../src/domain/access.js";
it("never exposes temporary draft rows to another database connection, even during a mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "docs-draft-isolation-"));
  const path = join(dir, "docs.db");
  const db = openDatabase(path);
  const service = new DocumentService(db);
  const doc = service.create(
    createDocumentSchema.parse({ title: "Shared", body: "Published" }),
  );
  const otherDb = openDatabase(path);
  const other = new DocumentService(otherDb);
  try {
    const runId = "00000000-0000-4000-8000-999999999999";
    const access: ScopedDocumentAccess = {
      kind: "scoped",
      subject: "Agent",
      runId,
      readCollectionIds: ["workspace"],
      writeCollectionIds: ["workspace"],
    };
    service.runChanges.open(runId, "review");
    const originalRecord = service.runChanges.record.bind(service.runChanges);
    let checked = false;
    service.runChanges.record = (...args) => {
      expect(service.runChanges.snapshot(doc.id).body).toBe("Draft");
      expect(other.get({ id: doc.id }).body).toBe("Published");
      expect(other.runChanges.history.list({ kind: "admin" })).toHaveLength(1);
      checked = true;
      return originalRecord(...args);
    };
    service.update({ id: doc.id }, { body: "Draft" }, access);
    expect(checked).toBe(true);
    expect(other.get({ id: doc.id }).body).toBe("Published");
    expect(other.get({ id: doc.id }, access).body).toBe("Draft");
  } finally {
    closeDatabase(otherDb);
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  }
});
