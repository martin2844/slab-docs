import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("applies operational defaults and coerces the port", () => {
    expect(loadConfig({ DOCS_API_KEY: "secret", PORT: "7000" })).toEqual({
      port: 7000,
      apiKey: "secret",
      dbPath: "/data/slab-docs.db",
      host: "0.0.0.0",
      environment: "development",
      skipMigrations: false
    });
  });

  it("accepts explicit deployment values", () => {
    expect(
      loadConfig({
        DOCS_API_KEY: " key ",
        DOCS_DB_PATH: "/tmp/docs.db",
        HOST: "127.0.0.1",
        NODE_ENV: "production"
      })
    ).toMatchObject({
      apiKey: "key",
      dbPath: "/tmp/docs.db",
      host: "127.0.0.1",
      environment: "production"
    });
  });

  it("fails closed without an API key or with an invalid port", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ DOCS_API_KEY: "secret", PORT: "0" })).toThrow();
  });

  it("reads a mounted API key and rejects ambiguous secret sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "slab-docs-secret-"));
    directories.push(directory);
    const secretPath = join(directory, "docs-api-key");
    writeFileSync(secretPath, "file-backed-test-key\n", { mode: 0o600 });

    expect(loadConfig({ DOCS_API_KEY_FILE: secretPath })).toMatchObject({
      apiKey: "file-backed-test-key"
    });
    expect(() => loadConfig({ DOCS_API_KEY: "direct", DOCS_API_KEY_FILE: secretPath })).toThrow(
      /only one/
    );
    expect(() => loadConfig({ DOCS_API_KEY_FILE: join(directory, "missing") })).toThrow(
      "DOCS_API_KEY_FILE could not be read."
    );
  });

  it("parses the explicit one-shot migration gate", () => {
    expect(loadConfig({ DOCS_API_KEY: "secret", SKIP_MIGRATIONS: "true" }).skipMigrations).toBe(
      true
    );
  });
});
