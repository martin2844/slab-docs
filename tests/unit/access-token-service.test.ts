import { describe, expect, it } from "vitest";
import { AccessTokenService } from "../../src/services/access-token-service.js";

describe("Docs access tokens", () => {
  it("rejects tampering, expiry, and write scopes outside the read scope", () => {
    let now = 1_800_000_000;
    const service = new AccessTokenService("master-secret", () => now);
    const issued = service.issue({
      subject: "run:1",
      readCollectionIds: ["workspace"],
      writeCollectionIds: ["workspace"],
      ttlSeconds: 60,
    });
    expect(service.verify(issued.token)).toMatchObject({
      kind: "scoped",
      subject: "run:1",
      readCollectionIds: ["workspace"],
      writeCollectionIds: ["workspace"],
    });
    expect(() => service.verify(`${issued.token}x`)).toThrow(/invalid/i);
    now += 61;
    expect(() => service.verify(issued.token)).toThrow(/expired/i);

    const invalidScope = service.issue({
      subject: "run:2",
      readCollectionIds: [],
      writeCollectionIds: ["workspace"],
    });
    expect(() => service.verify(invalidScope.token)).toThrow(/invalid/i);
  });
});
