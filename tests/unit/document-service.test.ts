import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DocumentService } from "../../src/services/document-service.js";
import {
  createDocumentSchema,
  listDocumentsSchema,
  searchDocumentsSchema,
  updateDocumentSchema
} from "../../src/schemas/documents.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../src/errors.js";
import { createTestContext } from "../helpers/context.js";

type Context = ReturnType<typeof createTestContext>;

function createDoc(
  service: DocumentService,
  values: Partial<Parameters<DocumentService["create"]>[0]> = {}
) {
  return service.create(
    createDocumentSchema.parse({
      title: "Autocorp",
      body: "# Autocorp\n\nCustomer notes.",
      ...values
    })
  );
}

function listDocs(
  service: DocumentService,
  values: Partial<Parameters<DocumentService["list"]>[0]> = {}
) {
  return service.list(listDocumentsSchema.parse(values));
}

function searchDocs(service: DocumentService, query: string, limit = 20) {
  return service.search(searchDocumentsSchema.parse({ query, limit }));
}

describe("DocumentService", () => {
  let context: Context;

  beforeEach(() => {
    context = createTestContext();
  });

  afterEach(() => {
    context.database.close();
  });

  it("creates, reads, and lists documents with an initial revision", () => {
    const document = createDoc(context.service, { tags: ["sales", "customer"] });

    expect(document).toMatchObject({
      slug: "autocorp",
      title: "Autocorp",
      parent_id: null,
      tags: ["sales", "customer"],
      archived_at: null
    });
    expect(context.service.get({ id: document.id })).toEqual(document);
    expect(context.service.get({ slug: "autocorp" })).toEqual(document);
    expect(listDocs(context.service)).toEqual([document]);
    expect(context.service.listRevisions({ slug: "autocorp" })).toMatchObject([
      { revision: 1, title: "Autocorp", author: "system" }
    ]);
  });

  it("generates unique slugs while rejecting duplicate explicit slugs", () => {
    const first = createDoc(context.service);
    const second = createDoc(context.service);
    const third = createDoc(context.service);

    expect([first.slug, second.slug, third.slug]).toEqual(["autocorp", "autocorp-2", "autocorp-3"]);
    expect(() => createDoc(context.service, { slug: "autocorp" })).toThrow(ConflictError);
  });

  it("supports roots, parent filters, tags, pagination, and FTS list filters", () => {
    const root = createDoc(context.service, { title: "Handbook", body: "Company knowledge" });
    const child = createDoc(context.service, {
      title: "Pricing",
      body: "Enterprise plans",
      parent_id: root.id,
      tags: ["Sales"]
    });
    createDoc(context.service, { title: "Product", body: "Roadmap", tags: ["product"] });

    expect(listDocs(context.service, { parent_id: null })).toHaveLength(2);
    expect(listDocs(context.service, { parent_id: root.id })).toEqual([child]);
    expect(listDocs(context.service, { tag: "sales" })).toEqual([child]);
    expect(listDocs(context.service, { search: "enterprise" })).toEqual([child]);
    expect(listDocs(context.service, { limit: 1, offset: 1 })).toHaveLength(1);
  });

  it("rejects missing, archived, self, and descendant parents", () => {
    const root = createDoc(context.service, { title: "Root" });
    const child = createDoc(context.service, { title: "Child", parent_id: root.id });
    const grandchild = createDoc(context.service, { title: "Grandchild", parent_id: child.id });
    const missingId = "00000000-0000-4000-8000-999999999999";

    expect(() => createDoc(context.service, { title: "Orphan", parent_id: missingId })).toThrow(
      BadRequestError
    );
    expect(() =>
      context.service.update(root.id ? { id: root.id } : { slug: root.slug }, updateDocumentSchema.parse({ parent_id: root.id }))
    ).toThrow(BadRequestError);
    expect(() =>
      context.service.update({ id: root.id }, updateDocumentSchema.parse({ parent_id: grandchild.id }))
    ).toThrow(BadRequestError);

    context.service.archive({ id: child.id });
    expect(() => createDoc(context.service, { title: "Archived child", parent_id: child.id })).toThrow(
      BadRequestError
    );
  });

  it("creates revisions only for title or body changes", () => {
    const document = createDoc(context.service, { author: "Martin" });
    const metadataUpdate = context.service.update(
      { id: document.id },
      updateDocumentSchema.parse({ tags: ["sales"], author: "Ignored" })
    );
    expect(metadataUpdate.tags).toEqual(["sales"]);
    expect(context.service.listRevisions({ id: document.id })).toHaveLength(1);

    const contentUpdate = context.service.update(
      { slug: document.slug },
      updateDocumentSchema.parse({ title: "Autocorp pricing", body: "New pricing", author: "Ana" })
    );
    expect(contentUpdate.title).toBe("Autocorp pricing");
    expect(context.service.listRevisions({ id: document.id })).toMatchObject([
      { revision: 2, title: "Autocorp pricing", body: "New pricing", author: "Ana" },
      { revision: 1, title: "Autocorp", author: "Martin" }
    ]);
    expect(context.service.getRevision({ id: document.id }, 1).body).toContain("Customer notes");
    expect(context.service.getRevision({ slug: document.slug }, 2).body).toBe("New pricing");
  });

  it("treats identical updates and repeated archives as idempotent", () => {
    const document = createDoc(context.service);
    const unchanged = context.service.update(
      { id: document.id },
      updateDocumentSchema.parse({ title: document.title })
    );
    expect(unchanged.updated_at).toBe(document.updated_at);
    expect(context.service.listRevisions({ id: document.id })).toHaveLength(1);

    const archived = context.service.archive({ id: document.id });
    expect(context.service.archive({ id: document.id })).toEqual(archived);
    expect(listDocs(context.service)).toEqual([]);
    expect(listDocs(context.service, { archived: true })).toEqual([archived]);
    expect(context.service.get({ id: document.id }).archived_at).not.toBeNull();
  });

  it("searches title, body, and tags, updates the FTS index, and omits archives", () => {
    const titleMatch = createDoc(context.service, { title: "Autocorp integration", body: "Overview" });
    const bodyMatch = createDoc(context.service, { title: "API", body: "Confidential pricing model" });
    const tagMatch = createDoc(context.service, {
      title: "Contract",
      body: "Terms",
      tags: ["enterprise-customer"]
    });

    expect(searchDocs(context.service, "autoc").map(({ id }) => id)).toContain(titleMatch.id);
    expect(searchDocs(context.service, "pricing").map(({ id }) => id)).toContain(bodyMatch.id);
    expect(searchDocs(context.service, "enterprise").map(({ id }) => id)).toContain(tagMatch.id);
    expect(searchDocs(context.service, "pricing")[0]).toMatchObject({
      excerpt: expect.stringContaining("pricing"),
      score: expect.any(Number)
    });

    context.service.update(
      { id: bodyMatch.id },
      updateDocumentSchema.parse({ body: "Updated wholesale rates" })
    );
    expect(searchDocs(context.service, "confidential")).toEqual([]);
    expect(searchDocs(context.service, "wholesale")).toHaveLength(1);

    context.service.archive({ id: tagMatch.id });
    expect(searchDocs(context.service, "enterprise")).toEqual([]);
    expect(() => searchDocs(context.service, "?!")).toThrow(BadRequestError);
  });

  it("reports missing documents and revisions", () => {
    const missingId = "00000000-0000-4000-8000-999999999999";
    expect(() => context.service.get({ id: missingId })).toThrow(NotFoundError);

    const document = createDoc(context.service);
    expect(() => context.service.getRevision({ id: document.id }, 99)).toThrow(NotFoundError);
  });
});
