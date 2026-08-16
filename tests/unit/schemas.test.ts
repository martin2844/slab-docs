import { describe, expect, it } from "vitest";
import {
  createDocumentSchema,
  listDocumentsQuerySchema,
  searchDocumentsQuerySchema,
  slugSchema,
  updateDocumentSchema
} from "../../src/schemas/documents.js";

describe("document schemas", () => {
  it("normalizes create input and supplies tags", () => {
    expect(createDocumentSchema.parse({ title: " Pricing ", body: "# Pricing" })).toEqual({
      title: "Pricing",
      body: "# Pricing",
      tags: []
    });
    expect(
      createDocumentSchema.parse({ title: "Doc", body: "", tags: [" Sales ", "sales"] }).tags
    ).toEqual(["Sales"]);
  });

  it("validates slugs, unknown fields, and meaningful updates", () => {
    expect(slugSchema.safeParse("api-pricing").success).toBe(true);
    expect(slugSchema.safeParse("API Pricing").success).toBe(false);
    expect(createDocumentSchema.safeParse({ title: "Doc", body: "", extra: true }).success).toBe(
      false
    );
    expect(updateDocumentSchema.safeParse({ author: "Martin" }).success).toBe(false);
    expect(updateDocumentSchema.safeParse({ parent_id: null }).success).toBe(true);
  });

  it("coerces HTTP pagination and parses archived safely", () => {
    expect(listDocumentsQuerySchema.parse({ limit: "10", offset: "2", archived: "false" })).toEqual(
      { limit: 10, offset: 2, archived: false }
    );
    expect(listDocumentsQuerySchema.parse({ archived: "true" }).archived).toBe(true);
    expect(listDocumentsQuerySchema.safeParse({ archived: "yes" }).success).toBe(false);
    expect(searchDocumentsQuerySchema.parse({ q: " pricing " })).toEqual({
      q: "pricing",
      limit: 20
    });
  });
});
