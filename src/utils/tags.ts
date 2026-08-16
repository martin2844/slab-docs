import { BadRequestError } from "../errors.js";

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawTag of tags) {
    const tag = rawTag.trim();
    const key = tag.toLocaleLowerCase();
    if (tag.length > 0 && !seen.has(key)) {
      seen.add(key);
      normalized.push(tag);
    }
  }

  return normalized;
}

export function serializeTags(tags: readonly string[]): string {
  return JSON.stringify(tags);
}

export function deserializeTags(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BadRequestError("Stored document tags are not valid JSON.");
  }

  if (!Array.isArray(parsed) || !parsed.every((tag) => typeof tag === "string")) {
    throw new BadRequestError("Stored document tags must be an array of strings.");
  }

  return parsed;
}
