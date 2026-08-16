import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  toPublicError
} from "../../src/errors.js";
import { failure, success } from "../../src/http/envelope.js";
import { parseInput } from "../../src/http/validation.js";
import { buildFtsQuery } from "../../src/utils/search.js";
import { extractApiKey, secureEqual } from "../../src/utils/security.js";
import { slugify, slugWithSuffix } from "../../src/utils/slug.js";
import { deserializeTags, normalizeTags, serializeTags } from "../../src/utils/tags.js";

describe("slug utilities", () => {
  it("creates stable ASCII slugs and a useful fallback", () => {
    expect(slugify("  Precios de Autocórp!  ")).toBe("precios-de-autocorp");
    expect(slugify("---")).toBe("document");
    expect(slugify("a".repeat(120))).toHaveLength(100);
  });

  it("adds bounded uniqueness suffixes", () => {
    expect(slugWithSuffix("api-pricing", 2)).toBe("api-pricing-2");
    expect(slugWithSuffix("a".repeat(100), 10)).toHaveLength(100);
    expect(() => slugWithSuffix("document", 1)).toThrow(RangeError);
    expect(() => slugWithSuffix("document", 2.5)).toThrow(RangeError);
  });
});

describe("search utilities", () => {
  it("builds a safe prefix AND query and removes duplicate terms", () => {
    expect(buildFtsQuery("Pricing autocorp pricing")).toBe('"pricing"* AND "autocorp"*');
    expect(buildFtsQuery("Información-API_2")).toBe('"información-api_2"*');
  });

  it("rejects queries without searchable characters", () => {
    expect(() => buildFtsQuery("?! …")).toThrow(BadRequestError);
  });
});

describe("tag utilities", () => {
  it("trims and de-duplicates tags without losing first-seen casing", () => {
    expect(normalizeTags([" Sales ", "sales", "B2B", ""])).toEqual(["Sales", "B2B"]);
  });

  it("round-trips stored tags and rejects corrupt values", () => {
    expect(deserializeTags(serializeTags(["sales", "b2b"]))).toEqual(["sales", "b2b"]);
    expect(() => deserializeTags("{")) .toThrow(BadRequestError);
    expect(() => deserializeTags('{"tag":"sales"}')).toThrow(BadRequestError);
    expect(() => deserializeTags('["sales", 2]')).toThrow(BadRequestError);
  });
});

describe("API key utilities", () => {
  it("compares keys and extracts either supported header", () => {
    expect(secureEqual("secret", "secret")).toBe(true);
    expect(secureEqual("secret", "other")).toBe(false);
    expect(extractApiKey({ authorization: "Bearer secret" })).toBe("secret");
    expect(extractApiKey({ authorization: ["bearer first", "Bearer second"] })).toBe("first");
    expect(extractApiKey({ "x-api-key": " legacy " })).toBe("legacy");
    expect(extractApiKey({ authorization: "Basic nope", "x-api-key": ["fallback"] })).toBe(
      "fallback"
    );
    expect(extractApiKey({})).toBeNull();
  });
});

describe("validation and response utilities", () => {
  it("parses valid values and exposes compact validation details", () => {
    expect(parseInput(z.object({ count: z.number().int() }), { count: 2 })).toEqual({ count: 2 });
    expect(() => parseInput(z.object({ count: z.number().int() }), { count: 2.5 })).toThrowError(
      expect.objectContaining({
        code: "bad_request",
        details: [{ path: "count", message: expect.any(String) }]
      })
    );
  });

  it("builds success and error envelopes", () => {
    expect(success({ id: "one" })).toEqual({ data: { id: "one" }, error: null });
    expect(failure({ code: "not_found", message: "Missing" })).toEqual({
      data: null,
      error: { code: "not_found", message: "Missing" }
    });
  });

  it("maps every domain error without leaking absent details", () => {
    expect(toPublicError(new BadRequestError("Bad", { field: "title" }))).toEqual({
      code: "bad_request",
      message: "Bad",
      details: { field: "title" }
    });
    expect(toPublicError(new UnauthorizedError())).toEqual({
      code: "unauthorized",
      message: "A valid API key is required."
    });
    expect(new NotFoundError("Missing").status).toBe(404);
    expect(new ConflictError("Duplicate").status).toBe(409);
    expect(new AppError(500, "internal_error", "Broken").name).toBe("AppError");
  });
});
