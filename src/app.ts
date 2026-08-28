import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { apiKeyAuth } from "./http/auth.js";
import { errorHandler, notFoundHandler } from "./http/error-handler.js";
import type { Logger } from "./http/error-handler.js";
import { createDocumentsRouter, createSearchRouter } from "./http/routes.js";
import { createMcpServer } from "./mcp/server.js";
import type { DocumentService } from "./services/document-service.js";
import { AccessTokenService } from "./services/access-token-service.js";
import { documentAccess } from "./http/auth.js";
import { parseInput } from "./http/validation.js";
import { z } from "zod";
import { success } from "./http/envelope.js";
import { ForbiddenError, BadRequestError } from "./errors.js";

const issueAccessTokenSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    readCollectionIds: z.array(z.string().trim().min(1).max(100)).max(200),
    writeCollectionIds: z.array(z.string().trim().min(1).max(100)).max(200),
    ttlSeconds: z.number().int().min(60).max(86_400).optional(),
  })
  .strict();

interface ApplicationOptions {
  service: DocumentService;
  apiKey: string;
  logger?: Logger;
  readiness?: () => { ready: boolean; details?: Record<string, unknown> };
}

export function createApplication({
  service,
  apiKey,
  logger = console,
  readiness = () => ({ ready: true }),
}: ApplicationOptions) {
  const app = express();
  const accessTokens = new AccessTokenService(apiKey);
  const authenticate = apiKeyAuth(apiKey, accessTokens);
  const mcp = createMcpHandler(
    (context) =>
      createMcpServer(service, accessTokens.fromAuthInfo(context.authInfo)),
    {
      legacy: "stateless",
      responseMode: "json",
      onerror: (error) => logger.error(error),
    },
  );
  const handleMcp = toNodeHandler(mcp);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });
  app.get("/ready", (_request, response) => {
    try {
      const result = readiness();
      response.status(result.ready ? 200 : 503).json({
        status: result.ready ? "ready" : "not_ready",
        ...result.details,
      });
    } catch {
      response.status(503).json({ status: "not_ready", database: "error" });
    }
  });

  app.use("/api", authenticate);
  app.post("/api/access-tokens", (request, response) => {
    const access = documentAccess(response.locals);
    if (access.kind !== "admin")
      throw new ForbiddenError("Admin Docs access is required.");
    const input = parseInput(issueAccessTokenSchema, request.body);
    if (
      input.writeCollectionIds.some(
        (id) => !input.readCollectionIds.includes(id),
      )
    ) {
      throw new BadRequestError("Write collections must also be readable.");
    }
    const collections = new Map(
      service
        .listCollections(access)
        .map((collection) => [collection.id, collection]),
    );
    const invalidWrite = input.writeCollectionIds.find(
      (id) => !collections.has(id) || collections.get(id)?.archived_at !== null,
    );
    if (invalidWrite !== undefined) {
      throw new BadRequestError(
        `Write collection "${invalidWrite}" is unavailable.`,
      );
    }
    response.status(201).json(success(accessTokens.issue(input)));
  });
  app.use("/api/documents", createDocumentsRouter(service));
  app.use("/api/search", createSearchRouter(service));

  app.all("/mcp", authenticate, (request, response, next) => {
    void handleMcp(request, response, request.body).catch(next);
  });

  app.use(notFoundHandler());
  app.use(errorHandler(logger));

  return { app, close: () => mcp.close() };
}
