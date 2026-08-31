import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../../src/app.js";
import { createTestContext } from "../helpers/context.js";

describe("REST API", () => {
  const apiKey = "test-api-key";
  let context: ReturnType<typeof createTestContext>;
  let runtime: ReturnType<typeof createApplication>;

  beforeEach(() => {
    context = createTestContext();
    runtime = createApplication({
      service: context.service,
      apiKey,
      logger: { error: vi.fn() },
    });
  });

  afterEach(async () => {
    await runtime.close();
    context.database.close();
  });

  it("keeps health public while protecting every API and MCP route", async () => {
    await request(runtime.app).get("/health").expect(200, { status: "ok" });
    await request(runtime.app).get("/ready").expect(200, { status: "ready" });

    const unauthorized = await request(runtime.app)
      .get("/api/documents")
      .expect(401);
    expect(unauthorized.headers["www-authenticate"]).toContain("Bearer");
    expect(unauthorized.body).toEqual({
      data: null,
      error: { code: "unauthorized", message: "A valid API key is required." },
    });

    await request(runtime.app)
      .post("/mcp")
      .set("Content-Type", "application/json")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      .expect(401);
    await request(runtime.app)
      .get("/api/documents")
      .set("x-api-key", apiKey)
      .expect(200);
    await request(runtime.app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${apiKey}`)
      .expect(200);
  });

  it("reports readiness failures without affecting process liveness", async () => {
    const unavailable = createApplication({
      service: context.service,
      apiKey,
      logger: { error: vi.fn() },
      readiness: () => ({
        ready: false,
        details: { database: "ok", migrations: { pending: [2] } },
      }),
    });
    try {
      await request(unavailable.app)
        .get("/health")
        .expect(200, { status: "ok" });
      await request(unavailable.app)
        .get("/ready")
        .expect(503, {
          status: "not_ready",
          database: "ok",
          migrations: { pending: [2] },
        });
    } finally {
      await unavailable.close();
    }
  });

  it("issues run-scoped tokens that enforce collection reads and workspace-only writes", async () => {
    const sourceA = "10000000-0000-4000-8000-000000000001";
    const sourceB = "10000000-0000-4000-8000-000000000002";
    context.service.ensureCollection({
      id: sourceA,
      name: "Sales handbook",
      kind: "source",
    });
    context.service.ensureCollection({
      id: sourceB,
      name: "Private finance",
      kind: "source",
    });
    const workspace = context.service.create({
      title: "Workspace truth",
      body: "Shared",
      tags: [],
      collection_id: "workspace",
    });
    const allowed = context.service.create({
      title: "Sales truth",
      body: "Allowed sales content",
      tags: [],
      collection_id: sourceA,
    });
    const hidden = context.service.create({
      title: "Finance truth",
      body: "Hidden finance content",
      tags: [],
      collection_id: sourceB,
    });

    const issued = await request(runtime.app)
      .post("/api/access-tokens")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        subject: "run:test:agent:sales",
        readCollectionIds: ["workspace", sourceA],
        writeCollectionIds: ["workspace"],
        ttlSeconds: 3600,
      })
      .expect(201);
    const token = issued.body.data.token as string;
    expect(token).toMatch(/^slabdocs_v1\./);

    const list = await request(runtime.app)
      .get("/api/documents")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(list.body.data.map(({ id }: { id: string }) => id).sort()).toEqual(
      [workspace.id, allowed.id].sort(),
    );
    const workspaceList = await request(runtime.app)
      .get("/api/documents?collection_id=workspace")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(workspaceList.body.data.map(({ id }: { id: string }) => id)).toEqual(
      [workspace.id],
    );
    const sourceSearch = await request(runtime.app)
      .get(`/api/search?q=sales&collection_id=${sourceA}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(sourceSearch.body.data).toMatchObject([{ id: allowed.id }]);
    const inaccessibleCollection = await request(runtime.app)
      .get(`/api/documents?collection_id=${sourceB}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(inaccessibleCollection.body.data).toEqual([]);
    await request(runtime.app)
      .get(`/api/documents/${hidden.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
    await request(runtime.app)
      .get("/api/search?q=finance")
      .set("Authorization", `Bearer ${token}`)
      .expect(200)
      .expect(({ body }) => expect(body.data).toEqual([]));

    await request(runtime.app)
      .patch(`/api/documents/${allowed.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Attempted overwrite" })
      .expect(403);
    expect(context.service.get({ id: allowed.id }).body).toBe(
      "Allowed sales content",
    );
    await request(runtime.app)
      .patch(`/api/documents/${workspace.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ body: "Agent-authored workspace update" })
      .expect(200);
    await request(runtime.app)
      .post("/api/access-tokens")
      .set("Authorization", `Bearer ${token}`)
      .send({
        subject: "escalation",
        readCollectionIds: ["workspace", sourceB],
        writeCollectionIds: ["workspace"],
      })
      .expect(403);
  });

  it("performs CRUD, hierarchy filtering, search, revisions, and archive through REST", async () => {
    const rootResponse = await request(runtime.app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        title: "Company handbook",
        body: "# Handbook",
        tags: ["company"],
      })
      .expect(201);
    const root = rootResponse.body.data as { id: string; slug: string };

    const childResponse = await request(runtime.app)
      .post("/api/documents")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({
        title: "Autocorp pricing",
        body: "Enterprise pricing is documented here.",
        parent_id: root.id,
        tags: ["sales"],
        author: "Martin",
      })
      .expect(201);
    const child = childResponse.body.data as { id: string; slug: string };
    expect(child.slug).toBe("autocorp-pricing");

    const list = await request(runtime.app)
      .get(`/api/documents?parent_id=${root.id}&tag=sales&limit=10&offset=0`)
      .set("x-api-key", apiKey)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.error).toBeNull();

    const get = await request(runtime.app)
      .get(`/api/documents/${child.id}`)
      .set("x-api-key", apiKey)
      .expect(200);
    expect(get.body.data.body).toContain("Enterprise pricing");

    await request(runtime.app)
      .patch(`/api/documents/${child.id}`)
      .set("x-api-key", apiKey)
      .send({ body: "Updated wholesale prices.", author: "Ana" })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.body).toBe("Updated wholesale prices.");
      });

    const search = await request(runtime.app)
      .get("/api/search?q=wholesale&limit=5")
      .set("x-api-key", apiKey)
      .expect(200);
    expect(search.body.data).toMatchObject([
      { id: child.id, slug: child.slug },
    ]);

    const filteredSearch = await request(runtime.app)
      .get("/api/documents?search=wholesale")
      .set("x-api-key", apiKey)
      .expect(200);
    expect(filteredSearch.body.data).toHaveLength(1);

    const revisions = await request(runtime.app)
      .get(`/api/documents/${child.id}/revisions`)
      .set("x-api-key", apiKey)
      .expect(200);
    expect(
      revisions.body.data.map(({ revision }: { revision: number }) => revision),
    ).toEqual([2, 1]);

    await request(runtime.app)
      .get(`/api/documents/${child.id}/revisions/1`)
      .set("x-api-key", apiKey)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.author).toBe("Martin");
      });

    await request(runtime.app)
      .delete(`/api/documents/${child.id}`)
      .set("x-api-key", apiKey)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data.archived_at).not.toBeNull();
      });

    await request(runtime.app)
      .get("/api/documents")
      .set("x-api-key", apiKey)
      .expect(200)
      .expect(({ body }) => expect(body.data).toHaveLength(1));
    await request(runtime.app)
      .get("/api/documents?archived=true")
      .set("x-api-key", apiKey)
      .expect(200)
      .expect(({ body }) => expect(body.data).toHaveLength(1));
  });

  it("returns consistent client errors for bad JSON, validation, conflicts, and missing resources", async () => {
    await request(runtime.app)
      .post("/api/documents")
      .set("x-api-key", apiKey)
      .set("Content-Type", "application/json")
      .send("{")
      .expect(400)
      .expect(({ body }) =>
        expect(body.error.message).toContain("not valid JSON"),
      );

    const invalid = await request(runtime.app)
      .post("/api/documents")
      .set("x-api-key", apiKey)
      .send({ title: "", body: "", unexpected: true })
      .expect(400);
    expect(invalid.body.error).toMatchObject({
      code: "bad_request",
      details: expect.any(Array),
    });

    const created = await request(runtime.app)
      .post("/api/documents")
      .set("x-api-key", apiKey)
      .send({ title: "API", slug: "api", body: "Docs" })
      .expect(201);
    await request(runtime.app)
      .post("/api/documents")
      .set("x-api-key", apiKey)
      .send({ title: "Another", slug: "api", body: "Docs" })
      .expect(409)
      .expect(({ body }) => expect(body.error.code).toBe("conflict"));

    await request(runtime.app)
      .patch(`/api/documents/${created.body.data.id}`)
      .set("x-api-key", apiKey)
      .send({ author: "Nobody" })
      .expect(400);
    await request(runtime.app)
      .get("/api/documents/not-a-uuid")
      .set("x-api-key", apiKey)
      .expect(400);
    await request(runtime.app)
      .get("/api/documents/00000000-0000-4000-8000-999999999999")
      .set("x-api-key", apiKey)
      .expect(404);
    await request(runtime.app)
      .get(`/api/documents/${created.body.data.id}/revisions/99`)
      .set("x-api-key", apiKey)
      .expect(404);
    await request(runtime.app)
      .get("/api/search?q=%3F%21")
      .set("x-api-key", apiKey)
      .expect(400);
    await request(runtime.app)
      .get("/api/unknown")
      .set("x-api-key", apiKey)
      .expect(404)
      .expect(({ body }) => expect(body.error.code).toBe("not_found"));
  });
});
