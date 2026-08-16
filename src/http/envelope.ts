import type { PublicError } from "../errors.js";

export interface SuccessEnvelope<T> {
  data: T;
  error: null;
}

export interface ErrorEnvelope {
  data: null;
  error: PublicError;
}

export function success<T>(data: T): SuccessEnvelope<T> {
  return { data, error: null };
}

export function failure(error: PublicError): ErrorEnvelope {
  return { data: null, error };
}
