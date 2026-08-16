import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, NotFoundError, toPublicError } from "../errors.js";
import { failure } from "./envelope.js";

export interface Logger {
  error(error: unknown): void;
}

function isInvalidJson(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    "status" in error &&
    error.status === 400 &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

export function notFoundHandler(): RequestHandler {
  return (request, response) => {
    const error = new NotFoundError(`Route ${request.method} ${request.path} was not found.`);
    response.status(error.status).json(failure(toPublicError(error)));
  };
}

export function errorHandler(logger: Logger = console): ErrorRequestHandler {
  return (error: unknown, _request, response, _next) => {
    if (isInvalidJson(error)) {
      const invalidJson = new AppError(400, "bad_request", "The request body is not valid JSON.");
      response.status(invalidJson.status).json(failure(toPublicError(invalidJson)));
      return;
    }

    if (error instanceof AppError) {
      response.status(error.status).json(failure(toPublicError(error)));
      return;
    }

    logger.error(error);
    const internal = new AppError(500, "internal_error", "An unexpected error occurred.");
    response.status(internal.status).json(failure(toPublicError(internal)));
  };
}
