export type ErrorCode =
  | "bad_request"
  | "conflict"
  | "internal_error"
  | "not_found"
  | "unauthorized";

export interface PublicError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  public constructor(message: string, details?: unknown) {
    super(400, "bad_request", message, details);
  }
}

export class UnauthorizedError extends AppError {
  public constructor(message = "A valid API key is required.") {
    super(401, "unauthorized", message);
  }
}

export class NotFoundError extends AppError {
  public constructor(message: string) {
    super(404, "not_found", message);
  }
}

export class ConflictError extends AppError {
  public constructor(message: string) {
    super(409, "conflict", message);
  }
}

export function toPublicError(error: AppError): PublicError {
  const result: PublicError = { code: error.code, message: error.message };
  if (error.details !== undefined) result.details = error.details;
  return result;
}
