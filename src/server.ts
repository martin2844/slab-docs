import "dotenv/config";
import { createServer } from "node:http";
import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/database.js";
import { DocumentService } from "./services/document-service.js";

const config = loadConfig();
const database = openDatabase(config.dbPath);
const service = new DocumentService(database);
const runtime = createApplication({ service, apiKey: config.apiKey });
const httpServer = createServer(runtime.app);

httpServer.listen(config.port, config.host, () => {
  console.log(`Slab Docs is listening on http://${config.host}:${config.port}`);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; shutting down Slab Docs.`);

  httpServer.close((error) => {
    void closeResources(error);
  });
}

async function closeResources(error?: Error): Promise<void> {
  try {
    await runtime.close();
    database.close();
    if (error !== undefined) {
      console.error(error);
      process.exitCode = 1;
    }
  } catch (closeError) {
    console.error(closeError);
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
