import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { apiKeyAuth } from "./http/auth.js";
import { errorHandler, notFoundHandler } from "./http/error-handler.js";
import type { Logger } from "./http/error-handler.js";
import { createDocumentsRouter, createSearchRouter } from "./http/routes.js";
import { createMcpServer } from "./mcp/server.js";
import type { DocumentService } from "./services/document-service.js";

interface ApplicationOptions {
  service: DocumentService;
  apiKey: string;
  logger?: Logger;
}

export function createApplication({ service, apiKey, logger = console }: ApplicationOptions) {
  const app = express();
  const authenticate = apiKeyAuth(apiKey);
  const mcp = createMcpHandler(() => createMcpServer(service), {
    legacy: "stateless",
    responseMode: "json",
    onerror: (error) => logger.error(error)
  });
  const handleMcp = toNodeHandler(mcp);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use("/api", authenticate);
  app.use("/api/documents", createDocumentsRouter(service));
  app.use("/api/search", createSearchRouter(service));

  app.all("/mcp", authenticate, (request, response, next) => {
    void handleMcp(request, response, request.body).catch(next);
  });

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return { app, close: () => mcp.close() };
}
