import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { DocumentAccess, ScopedDocumentAccess } from "../domain/access.js";
import { ADMIN_DOCUMENT_ACCESS } from "../domain/access.js";
import { UnauthorizedError } from "../errors.js";

const TOKEN_PREFIX = "slabdocs_v1";
const MAX_TTL_SECONDS = 86_400;

const payloadSchema = z
  .object({
    v: z.literal(1),
    sub: z.string().trim().min(1).max(200),
    iat: z.number().int().positive(),
    exp: z.number().int().positive(),
    read: z.array(z.string().trim().min(1).max(100)).max(200),
    write: z.array(z.string().trim().min(1).max(100)).max(200),
  })
  .strict();

export interface IssueAccessTokenInput {
  subject: string;
  readCollectionIds: readonly string[];
  writeCollectionIds: readonly string[];
  ttlSeconds?: number | undefined;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload, "utf8").digest();
}

function safeSignatureEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class AccessTokenService {
  public constructor(
    private readonly secret: string,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  public issue(input: IssueAccessTokenInput): IssuedAccessToken {
    const ttlSeconds = Math.min(
      Math.max(input.ttlSeconds ?? MAX_TTL_SECONDS, 60),
      MAX_TTL_SECONDS,
    );
    const issuedAt = this.now();
    const payload = payloadSchema.parse({
      v: 1,
      sub: input.subject,
      iat: issuedAt,
      exp: issuedAt + ttlSeconds,
      read: unique(input.readCollectionIds),
      write: unique(input.writeCollectionIds),
    });
    const encodedPayload = Buffer.from(
      JSON.stringify(payload),
      "utf8",
    ).toString("base64url");
    const encodedSignature = signature(this.secret, encodedPayload).toString(
      "base64url",
    );
    return {
      token: `${TOKEN_PREFIX}.${encodedPayload}.${encodedSignature}`,
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    };
  }

  public verify(token: string): ScopedDocumentAccess {
    const [prefix, encodedPayload, encodedSignature, extra] = token.split(".");
    if (
      prefix !== TOKEN_PREFIX ||
      encodedPayload === undefined ||
      encodedSignature === undefined ||
      extra !== undefined
    ) {
      throw new UnauthorizedError("The Docs access token is invalid.");
    }

    let parsed: z.infer<typeof payloadSchema>;
    try {
      const expected = signature(this.secret, encodedPayload);
      const provided = Buffer.from(encodedSignature, "base64url");
      if (!safeSignatureEqual(expected, provided)) throw new Error("signature");
      parsed = payloadSchema.parse(
        JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")),
      );
    } catch {
      throw new UnauthorizedError("The Docs access token is invalid.");
    }

    if (parsed.exp <= this.now())
      throw new UnauthorizedError("The Docs access token has expired.");
    if (
      parsed.iat > this.now() + 60 ||
      parsed.exp - parsed.iat > MAX_TTL_SECONDS
    ) {
      throw new UnauthorizedError("The Docs access token is invalid.");
    }
    const readCollectionIds = unique(parsed.read);
    const writeCollectionIds = unique(parsed.write);
    if (
      writeCollectionIds.some(
        (collectionId) => !readCollectionIds.includes(collectionId),
      )
    ) {
      throw new UnauthorizedError("The Docs access token is invalid.");
    }
    return {
      kind: "scoped",
      subject: parsed.sub,
      readCollectionIds,
      writeCollectionIds,
    };
  }

  public toAuthInfo(token: string, access: DocumentAccess): AuthInfo {
    if (access.kind === "admin") {
      return { token, clientId: "slab-control-plane", scopes: ["docs:admin"] };
    }
    return {
      token,
      clientId: access.subject,
      scopes: ["docs:scoped"],
      extra: {
        subject: access.subject,
        readCollectionIds: [...access.readCollectionIds],
        writeCollectionIds: [...access.writeCollectionIds],
      },
    };
  }

  public fromAuthInfo(authInfo: AuthInfo | undefined): DocumentAccess {
    if (authInfo?.scopes.includes("docs:admin")) return ADMIN_DOCUMENT_ACCESS;
    const parsed = z
      .object({
        subject: z.string(),
        readCollectionIds: z.array(z.string()),
        writeCollectionIds: z.array(z.string()),
      })
      .safeParse(authInfo?.extra);
    if (!parsed.success) throw new UnauthorizedError();
    return {
      kind: "scoped",
      subject: parsed.data.subject,
      readCollectionIds: unique(parsed.data.readCollectionIds),
      writeCollectionIds: unique(parsed.data.writeCollectionIds),
    };
  }
}
