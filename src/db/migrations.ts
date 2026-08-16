import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "documents_and_revisions",
    sql: `
      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        parent_id TEXT REFERENCES documents(id) ON DELETE RESTRICT,
        tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        CHECK (parent_id IS NULL OR parent_id <> id)
      );

      CREATE INDEX documents_parent_id_idx ON documents(parent_id);
      CREATE INDEX documents_archived_at_idx ON documents(archived_at);
      CREATE INDEX documents_updated_at_idx ON documents(updated_at DESC);

      CREATE TABLE document_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK (revision > 0),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(document_id, revision)
      );

      CREATE INDEX document_revisions_document_id_idx
        ON document_revisions(document_id, revision DESC);
    `
  },
  {
    version: 2,
    name: "documents_fts",
    sql: `
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        title,
        body,
        tags,
        content='documents',
        content_rowid='rowid',
        tokenize='unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER documents_fts_insert AFTER INSERT ON documents BEGIN
        INSERT INTO documents_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END;

      CREATE TRIGGER documents_fts_delete AFTER DELETE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
      END;

      CREATE TRIGGER documents_fts_update AFTER UPDATE ON documents BEGIN
        INSERT INTO documents_fts(documents_fts, rowid, title, body, tags)
        VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        INSERT INTO documents_fts(rowid, title, body, tags)
        VALUES (new.rowid, new.title, new.body, new.tags);
      END;

      INSERT INTO documents_fts(documents_fts) VALUES ('rebuild');
    `
  }
];

export function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = database.prepare("SELECT version FROM schema_migrations").all() as Array<{
    version: number;
  }>;
  const applied = new Set(appliedRows.map(({ version }) => version));
  const insertMigration = database.prepare(
    "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)"
  );

  const applyMigration = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    insertMigration.run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) applyMigration(migration);
  }
}
