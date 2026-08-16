import type { RequestHandler } from "express";
import { UnauthorizedError, toPublicError } from "../errors.js";
import { failure } from "./envelope.js";
import { extractApiKey, secureEqual } from "../utils/security.js";

export function apiKeyAuth(expectedApiKey: string): RequestHandler {
  return (request, response, next) => {
    const providedApiKey = extractApiKey(request.headers);
    if (providedApiKey !== null && secureEqual(providedApiKey, expectedApiKey)) {
      next();
      return;
    }

    const error = new UnauthorizedError();
    response.setHeader("WWW-Authenticate", 'Bearer realm="slab-docs"');
    response.status(error.status).json(failure(toPublicError(error)));
  };
}
