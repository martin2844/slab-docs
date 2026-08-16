import { z } from "zod";

const configSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(6980),
  DOCS_API_KEY: z.string().trim().min(1, "DOCS_API_KEY must not be empty."),
  DOCS_DB_PATH: z.string().trim().min(1).default("/data/slab-docs.db"),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development")
});

export interface Config {
  port: number;
  apiKey: string;
  dbPath: string;
  host: string;
  environment: "development" | "test" | "production";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.parse(environment);
  return {
    port: parsed.PORT,
    apiKey: parsed.DOCS_API_KEY,
    dbPath: parsed.DOCS_DB_PATH,
    host: parsed.HOST,
    environment: parsed.NODE_ENV
  };
}
