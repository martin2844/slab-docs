import type { Request, RequestHandler } from "express";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { DocumentAccess } from "../domain/access.js";
import { UnauthorizedError, toPublicError } from "../errors.js";
import { failure } from "./envelope.js";
import { extractApiKey, secureEqual } from "../utils/security.js";
import type { AccessTokenService } from "../services/access-token-service.js";

type AuthenticatedRequest = Request & { auth?: AuthInfo };

export function apiKeyAuth(
  expectedApiKey: string,
  accessTokens: AccessTokenService,
): RequestHandler {
  return (request, response, next) => {
    const providedApiKey = extractApiKey(request.headers);
    if (
      providedApiKey !== null &&
      secureEqual(providedApiKey, expectedApiKey)
    ) {
      const access: DocumentAccess = { kind: "admin" };
      response.locals.documentAccess = access;
      (request as AuthenticatedRequest).auth = accessTokens.toAuthInfo(
        providedApiKey,
        access,
      );
      next();
      return;
    }

    if (providedApiKey !== null) {
      try {
        const access = accessTokens.verify(providedApiKey);
        response.locals.documentAccess = access;
        (request as AuthenticatedRequest).auth = accessTokens.toAuthInfo(
          providedApiKey,
          access,
        );
        next();
        return;
      } catch {
        // Return one stable authentication error below.
      }
    }

    const error = new UnauthorizedError();
    response.setHeader("WWW-Authenticate", 'Bearer realm="slab-docs"');
    response.status(error.status).json(failure(toPublicError(error)));
  };
}

export function documentAccess(
  responseLocals: Record<string, unknown>,
): DocumentAccess {
  const access = responseLocals.documentAccess;
  if (
    typeof access === "object" &&
    access !== null &&
    "kind" in access &&
    (access.kind === "admin" || access.kind === "scoped")
  ) {
    return access as DocumentAccess;
  }
  throw new UnauthorizedError();
}
