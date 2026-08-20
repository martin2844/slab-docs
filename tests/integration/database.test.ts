import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import { getMigrationStatus, migrations, runMigrations } from "../../src/db/migrations.js";
import { createDocumentSchema } from "../../src/schemas/documents.js";
import { DocumentService } from "../../src/services/document-service.js";

describe("database lifecycle", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies each migration exactly once", () => {
    const database = openDatabase(":memory:");
    try {
      expect(
        database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()
      ).toEqual(migrations.map(({ version, name }) => ({ version, name })));
      expect(getMigrationStatus(database)).toEqual({
        ready: true,
        expected: [1, 2],
        applied: [1, 2],
        pending: []
      });
      runMigrations(database);
      expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({
        count: migrations.length
      });
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'")
          .get()
      ).toEqual({ name: "documents_fts" });
    } finally {
      database.close();
    }
  });

  it("can open an unmigrated database for a readiness-only process", () => {
    const database = openDatabase(":memory:", { migrate: false });
    try {
      expect(getMigrationStatus(database)).toEqual({
        ready: false,
        expected: [1, 2],
        applied: [],
        pending: [1, 2]
      });
    } finally {
      database.close();
    }
  });

  it("persists documents and revisions across a close/reopen cycle", () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-docs-persistence-"));
    directories.push(directory);
    const path = join(directory, "nested", "slab-docs.db");

    const firstDatabase = openDatabase(path);
    const firstService = new DocumentService(firstDatabase);
    const created = firstService.create(
      createDocumentSchema.parse({ title: "Persistent handbook", body: "Survives restarts" })
    );
    expect(firstDatabase.pragma("journal_mode", { simple: true })).toBe("wal");
    firstDatabase.close();

    const secondDatabase = openDatabase(path);
    try {
      const secondService = new DocumentService(secondDatabase);
      expect(secondService.get({ slug: created.slug })).toMatchObject({
        id: created.id,
        body: "Survives restarts"
      });
      expect(secondService.listRevisions({ id: created.id })).toHaveLength(1);
    } finally {
      secondDatabase.close();
    }
  });
});
