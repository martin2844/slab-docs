import { Router } from "express";
import { success } from "./envelope.js";
import { parseInput } from "./validation.js";
import {
  createDocumentSchema,
  documentIdSchema,
  listDocumentsQuerySchema,
  revisionNumberSchema,
  searchDocumentsQuerySchema,
  updateDocumentSchema
} from "../schemas/documents.js";
import type { DocumentService } from "../services/document-service.js";

export function createDocumentsRouter(service: DocumentService): Router {
  const router = Router();

  router.post("/", (request, response) => {
    const input = parseInput(createDocumentSchema, request.body);
    response.status(201).json(success(service.create(input)));
  });

  router.get("/", (request, response) => {
    const input = parseInput(listDocumentsQuerySchema, request.query);
    response.json(success(service.list(input)));
  });

  router.get("/:id/revisions", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    response.json(success(service.listRevisions({ id })));
  });

  router.get("/:id/revisions/:revision", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    const revision = parseInput(revisionNumberSchema, request.params.revision);
    response.json(success(service.getRevision({ id }, revision)));
  });

  router.get("/:id", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    response.json(success(service.get({ id })));
  });

  router.patch("/:id", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    const input = parseInput(updateDocumentSchema, request.body);
    response.json(success(service.update({ id }, input)));
  });

  router.delete("/:id", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    response.json(success(service.archive({ id })));
  });

  return router;
}

export function createSearchRouter(service: DocumentService): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const input = parseInput(searchDocumentsQuerySchema, request.query);
    response.json(success(service.search({ query: input.q, limit: input.limit })));
  });

  return router;
}
