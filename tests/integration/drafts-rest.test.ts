import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "../../src/app.js";
import { createTestContext } from "../helpers/context.js";
const runId = "00000000-0000-4000-8000-999999999999";
describe("Draft review API", () => {
  let c: ReturnType<typeof createTestContext>;
  let runtime: ReturnType<typeof createApplication>;
  const admin = "Bearer owner-key";
  beforeEach(() => {
    c = createTestContext();
    runtime = createApplication({
      service: c.service,
      apiKey: "owner-key",
      logger: { error: () => {} },
    });
  });
  afterEach(async () => {
    await runtime.close();
    c.database.close();
  });
  it("persists a private proposal, restricts publishing to the owner, and exposes commit diffs and revert", async () => {
    const issued = await request(runtime.app)
      .post("/api/access-tokens")
      .set("Authorization", admin)
      .send({
        subject: "Agent",
        author: "Vera",
        runId,
        editingMode: "review",
        readCollectionIds: ["workspace"],
        writeCollectionIds: ["workspace"],
      })
      .expect(201);
    expect(issued.body.data.features.draftChanges).toBe(1);
    const agent = `Bearer ${issued.body.data.token}`;
    const created = await request(runtime.app)
      .post("/api/documents")
      .set("Authorization", agent)
      .send({ title: "Private draft", body: "Pending" })
      .expect(201);
    const id = created.body.data.id;
    await request(runtime.app)
      .get(`/api/documents/${id}`)
      .set("Authorization", admin)
      .expect(404);
    for (const action of ["merge", "reject", "close", "undo"])
      await request(runtime.app)
        .post(`/api/run-changes/${runId}/${action}`)
        .set("Authorization", agent)
        .send({})
        .expect(403);
    await request(runtime.app).get("/api/proposals").expect(401);
    await request(runtime.app)
      .get("/api/proposals")
      .set("Authorization", agent)
      .expect(403);
    await request(runtime.app)
      .post(`/api/run-changes/${runId}/merge`)
      .set("Authorization", admin)
      .send({})
      .expect(409);
    await request(runtime.app)
      .post(`/api/run-changes/${runId}/close`)
      .set("Authorization", admin)
      .send({ successful: true })
      .expect(200);
    const pending = await request(runtime.app)
      .get("/api/proposals")
      .set("Authorization", admin)
      .expect(200);
    expect(pending.body.data).toMatchObject([
      { run_id: runId, author: "Vera", documentCount: 1 },
    ]);
    const merged = await request(runtime.app)
      .post(`/api/run-changes/${runId}/merge`)
      .set("Authorization", admin)
      .send({})
      .expect(200);
    expect(merged.body.data).toMatchObject({ state: "merged", closed: true });
    const commitId = merged.body.data.commitId;
    const detail = await request(runtime.app)
      .get(`/api/commits/${commitId}`)
      .set("Authorization", admin)
      .expect(200);
    expect(detail.body.data.changes[0]).toMatchObject({
      before: null,
      after: { body: "Pending" },
      conflict: null,
    });
    await request(runtime.app)
      .post(`/api/commits/${commitId}/revert`)
      .set("Authorization", agent)
      .send({})
      .expect(403);
    await request(runtime.app)
      .post(`/api/commits/${commitId}/revert`)
      .set("Authorization", admin)
      .send({})
      .expect(200);
    expect(c.service.get({ id }).archived_at).toBeTruthy();
    const history = await request(runtime.app)
      .get(`/api/commits?documentId=${id}`)
      .set("Authorization", admin)
      .expect(200);
    expect(history.body.data).toHaveLength(2);
  });
  it("rejects stale editor saves using the complete document mutation version", async () => {
    const created = await request(runtime.app)
      .post("/api/documents")
      .set("Authorization", admin)
      .send({ title: "Shared", body: "Original" })
      .expect(201);
    const { id, version } = created.body.data;
    await request(runtime.app)
      .patch(`/api/documents/${id}`)
      .set("Authorization", admin)
      .send({ body: "New", expected_version: version })
      .expect(200);
    await request(runtime.app)
      .patch(`/api/documents/${id}`)
      .set("Authorization", admin)
      .send({ body: "Stale", expected_version: version })
      .expect(409);
    expect(c.service.get({ id }).body).toBe("New");
  });
});
