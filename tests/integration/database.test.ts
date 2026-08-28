import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/db/database.js";
import {
  getMigrationStatus,
  migrations,
  runMigrations,
} from "../../src/db/migrations.js";
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
        database
          .prepare(
            "SELECT version, name FROM schema_migrations ORDER BY version",
          )
          .all(),
      ).toEqual(migrations.map(({ version, name }) => ({ version, name })));
      expect(getMigrationStatus(database)).toEqual({
        ready: true,
        expected: [1, 2, 3],
        applied: [1, 2, 3],
        pending: [],
      });
      runMigrations(database);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
          .get(),
      ).toEqual({
        count: migrations.length,
      });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'",
          )
          .get(),
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
        expected: [1, 2, 3],
        applied: [],
        pending: [1, 2, 3],
      });
    } finally {
      database.close();
    }
  });

  it("moves existing source-tagged documents into native collections", () => {
    const database = openDatabase(":memory:", { migrate: false });
    try {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of migrations.slice(0, 2)) {
        database.exec(migration.sql);
        database
          .prepare(
            "INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)",
          )
          .run(migration.version, migration.name, "2026-01-01T00:00:00.000Z");
      }
      const sourceId = "20000000-0000-4000-8000-000000000001";
      const insert = database.prepare(
        `INSERT INTO documents(
          id,slug,title,body,parent_id,tags,created_at,updated_at,archived_at
        ) VALUES (?,?,?,?,NULL,?,?,?,NULL)`,
      );
      insert.run(
        "30000000-0000-4000-8000-000000000001",
        "source-doc",
        "Source doc",
        "Managed",
        JSON.stringify([`source-id:${sourceId}`]),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );
      insert.run(
        "30000000-0000-4000-8000-000000000002",
        "workspace-doc",
        "Workspace doc",
        "Shared",
        "[]",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      );

      runMigrations(database);
      expect(
        database
          .prepare("SELECT slug,collection_id FROM documents ORDER BY slug")
          .all(),
      ).toEqual([
        { slug: "source-doc", collection_id: sourceId },
        { slug: "workspace-doc", collection_id: "workspace" },
      ]);
      expect(
        database
          .prepare("SELECT id,kind FROM document_collections WHERE id=?")
          .get(sourceId),
      ).toEqual({ id: sourceId, kind: "source" });
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
      createDocumentSchema.parse({
        title: "Persistent handbook",
        body: "Survives restarts",
      }),
    );
    expect(firstDatabase.pragma("journal_mode", { simple: true })).toBe("wal");
    firstDatabase.close();

    const secondDatabase = openDatabase(path);
    try {
      const secondService = new DocumentService(secondDatabase);
      expect(secondService.get({ slug: created.slug })).toMatchObject({
        id: created.id,
        body: "Survives restarts",
      });
      expect(secondService.listRevisions({ id: created.id })).toHaveLength(1);
    } finally {
      secondDatabase.close();
    }
  });
});
