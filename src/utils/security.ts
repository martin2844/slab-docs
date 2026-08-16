import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function secureEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

export function extractApiKey(headers: Record<string, string | string[] | undefined>): string | null {
  const authorization = headers.authorization;
  const authorizationValue = Array.isArray(authorization) ? authorization[0] : authorization;
  if (authorizationValue !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorizationValue.trim());
    if (match?.[1]) return match[1].trim();
  }

  const header = headers["x-api-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.trim() || null;
}
