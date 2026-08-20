import { z } from "zod";
import { readFileSync } from "node:fs";

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(6980),
  DOCS_API_KEY: z.string().trim().min(1, "DOCS_API_KEY must not be empty."),
  DOCS_DB_PATH: z.string().trim().min(1).default("/data/slab-docs.db"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SKIP_MIGRATIONS: z.enum(["true", "false"]).default("false")
});

export interface Config {
  port: number;
  apiKey: string;
  dbPath: string;
  host: string;
  environment: "development" | "test" | "production";
  skipMigrations: boolean;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const directApiKey = environment.DOCS_API_KEY;
  const apiKeyFile = environment.DOCS_API_KEY_FILE?.trim();
  if (directApiKey !== undefined && apiKeyFile) {
    throw new Error("Set only one of DOCS_API_KEY or DOCS_API_KEY_FILE.");
  }

  let apiKey = directApiKey;
  if (apiKeyFile) {
    try {
      apiKey = readFileSync(apiKeyFile, "utf8").trim();
    } catch {
      throw new Error("DOCS_API_KEY_FILE could not be read.");
    }
  }

  const parsed = configSchema.parse({ ...environment, DOCS_API_KEY: apiKey });
  return {
    port: parsed.PORT,
    apiKey: parsed.DOCS_API_KEY,
    dbPath: parsed.DOCS_DB_PATH,
    host: parsed.HOST,
    environment: parsed.NODE_ENV,
    skipMigrations: parsed.SKIP_MIGRATIONS === "true"
  };
}
