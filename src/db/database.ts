import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export type SlabDatabase = Database.Database;

export function openDatabase(path: string, options: { migrate?: boolean } = {}): SlabDatabase {
  if (path !== ":memory:" && !path.startsWith("file:")) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  database.pragma("synchronous = NORMAL");
  if (path !== ":memory:") database.pragma("journal_mode = WAL");
  if (options.migrate !== false) runMigrations(database);
  return database;
}

export function closeDatabase(database: SlabDatabase): void {
  if (!database.open) return;
  try {
    database.pragma("wal_checkpoint(PASSIVE)");
  } catch {
    // A second process may still hold the shared WAL. Closing remains safe.
  }
  database.close();
}
