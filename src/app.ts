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
    runId: z.string().uuid().optional(),
    editingMode: z.enum(["direct", "review", "auto"]).optional(),
    author: z.string().trim().min(1).max(200).optional(),
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
    if (input.editingMode && !input.runId)
      throw new BadRequestError("Draft editing requires a run ID.");
    if (input.runId)
      service.runChanges.open(input.runId, input.editingMode, input.author);
    response.status(201).json(
      success({
        ...accessTokens.issue(input),
        ...(input.runId
          ? { features: { runChanges: 1, draftChanges: 1 } }
          : {}),
      }),
    );
  });
  app.get("/api/run-changes/:runId", (request, response) => {
    const runId = parseInput(z.string().uuid(), request.params.runId);
    response.json(
      success(service.runChanges.list(runId, documentAccess(response.locals))),
    );
  });
  app.post("/api/run-changes/:runId/close", (request, response) => {
    if (documentAccess(response.locals).kind !== "admin")
      throw new ForbiddenError();
    const runId = parseInput(z.string().uuid(), request.params.runId);
    const input = parseInput(
      z.object({ successful: z.boolean().default(false) }).strict(),
      request.body ?? {},
    );
    if (
      service.runChanges.drafts.session(runId)?.editing_mode !== "direct" &&
      service.runChanges.drafts.session(runId)
    ) {
      response.json(
        success(
          service.runChanges.drafts.close(
            runId,
            input.successful,
            documentAccess(response.locals),
          ),
        ),
      );
    } else {
      service.runChanges.close(runId);
      response.json(success({ closed: true }));
    }
  });
  app.get("/api/proposals", (_request, response) => {
    response.json(
      success(
        service.runChanges.drafts.pending(documentAccess(response.locals)),
      ),
    );
  });
  for (const action of ["merge", "reject"] as const)
    app.post(`/api/run-changes/:runId/${action}`, (request, response) => {
      const runId = parseInput(z.string().uuid(), request.params.runId);
      service.runChanges.drafts[action](runId, documentAccess(response.locals));
      response.json(
        success(
          service.runChanges.list(runId, documentAccess(response.locals)),
        ),
      );
    });
  app.get("/api/commits", (request, response) => {
    const input = parseInput(
      z
        .object({
          documentId: z.string().uuid().optional(),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .strict(),
      request.query,
    );
    response.json(
      success(
        service.runChanges.history.list(
          documentAccess(response.locals),
          input.documentId,
          input.offset,
        ),
      ),
    );
  });
  app.get("/api/commits/:id", (request, response) => {
    response.json(
      success(
        service.runChanges.history.get(
          parseInput(z.string().uuid(), request.params.id),
          documentAccess(response.locals),
        ),
      ),
    );
  });
  app.post("/api/commits/:id/revert", (request, response) => {
    const access = documentAccess(response.locals);
    if (access.kind !== "admin") throw new ForbiddenError();
    response.json(
      success(
        service.revertCommit(
          parseInput(z.string().uuid(), request.params.id),
          access,
        ),
      ),
    );
  });
  app.post("/api/run-changes/:runId/undo", (request, response) => {
    const runId = parseInput(z.string().uuid(), request.params.runId);
    const input = parseInput(
      z
        .object({
          documentIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
        })
        .strict(),
      request.body,
    );
    response.json(
      success(
        service.runChanges.undo(
          runId,
          input.documentIds,
          documentAccess(response.locals),
        ),
      ),
    );
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
