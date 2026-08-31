import { Router } from "express";
import { success } from "./envelope.js";
import { parseInput } from "./validation.js";
import {
  createDocumentSchema,
  documentIdSchema,
  listDocumentsQuerySchema,
  revisionNumberSchema,
  searchDocumentsQuerySchema,
  updateDocumentSchema,
} from "../schemas/documents.js";
import type { DocumentService } from "../services/document-service.js";
import { documentAccess } from "./auth.js";

export function createDocumentsRouter(service: DocumentService): Router {
  const router = Router();

  router.post("/", (request, response) => {
    const input = parseInput(createDocumentSchema, request.body);
    response
      .status(201)
      .json(success(service.create(input, documentAccess(response.locals))));
  });

  router.get("/", (request, response) => {
    const input = parseInput(listDocumentsQuerySchema, request.query);
    response.json(
      success(service.list(input, documentAccess(response.locals))),
    );
  });

  router.get("/:id/revisions", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    response.json(
      success(service.listRevisions({ id }, documentAccess(response.locals))),
    );
  });

  router.get("/:id/revisions/:revision", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    const revision = parseInput(revisionNumberSchema, request.params.revision);
    response.json(
      success(
        service.getRevision({ id }, revision, documentAccess(response.locals)),
      ),
    );
  });

  router.get("/:id", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    response.json(
      success(service.get({ id }, documentAccess(response.locals))),
    );
  });

  router.patch("/:id", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    const input = parseInput(updateDocumentSchema, request.body);
    response.json(
      success(service.update({ id }, input, documentAccess(response.locals))),
    );
  });

  router.delete("/:id", (request, response) => {
    const id = parseInput(documentIdSchema, request.params.id);
    response.json(
      success(service.archive({ id }, documentAccess(response.locals))),
    );
  });

  return router;
}

export function createSearchRouter(service: DocumentService): Router {
  const router = Router();

  router.get("/", (request, response) => {
    const input = parseInput(searchDocumentsQuerySchema, request.query);
    response.json(
      success(
        service.search(
          {
            query: input.q,
            collection_id: input.collection_id,
            limit: input.limit,
          },
          documentAccess(response.locals),
        ),
      ),
    );
  });

  return router;
}
