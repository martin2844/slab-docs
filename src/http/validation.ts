import type { ZodType } from "zod";
import { BadRequestError } from "../errors.js";

export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new BadRequestError(
    "The request contains invalid or missing fields.",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  );
}
