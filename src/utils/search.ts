import { BadRequestError } from "../errors.js";

const TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;

export function buildFtsQuery(value: string): string {
  const tokens = value.normalize("NFKC").match(TOKEN_PATTERN) ?? [];
  const uniqueTokens = [...new Set(tokens.map((token) => token.toLocaleLowerCase()))];

  if (uniqueTokens.length === 0) {
    throw new BadRequestError("Search must contain at least one letter or number.");
  }

  return uniqueTokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" AND ");
}
