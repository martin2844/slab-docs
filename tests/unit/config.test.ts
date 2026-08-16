import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("applies operational defaults and coerces the port", () => {
    expect(loadConfig({ DOCS_API_KEY: "secret", PORT: "7000" })).toEqual({
      port: 7000,
      apiKey: "secret",
      dbPath: "/data/slab-docs.db",
      host: "0.0.0.0",
      environment: "development"
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
});
