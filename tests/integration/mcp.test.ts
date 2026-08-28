import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../../src/app.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { createTestContext } from "../helpers/context.js";

function payload(result: CallToolResult): {
  data: unknown;
  error: { code: string; message: string } | null;
} {
  const text = result.content.find((item) => item.type === "text");
  if (text?.type !== "text")
    throw new Error("Tool did not return text content.");
  return JSON.parse(text.text) as {
    data: unknown;
    error: { code: string; message: string } | null;
  };
}

describe("MCP tools", () => {
  const contexts: Array<ReturnType<typeof createTestContext>> = [];

  afterEach(() => {
    for (const context of contexts.splice(0)) context.database.close();
  });

  it("exposes all tools over the SDK and shares the complete document workflow", async () => {
    const context = createTestContext();
    contexts.push(context);
    const server = createMcpServer(context.service);
    const client = new Client({ name: "slab-docs-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name).sort()).toEqual(
        [
          "archive_collection",
          "archive_doc",
          "create_doc",
          "ensure_collection",
          "get_doc",
          "get_doc_revision",
          "list_doc_revisions",
          "list_docs",
          "search_docs",
          "update_doc",
        ].sort(),
      );

      const createResult = await client.callTool({
        name: "create_doc",
        arguments: {
          title: "Autocorp pricing",
          body: "Enterprise price list",
          tags: ["sales"],
          author: "Martin",
        },
      });
      expect(createResult.isError).not.toBe(true);
      const created = payload(createResult).data as {
        id: string;
        slug: string;
      };
      expect(created.slug).toBe("autocorp-pricing");
      expect(createResult.structuredContent).toBeUndefined();
      expect(payload(createResult).data).not.toHaveProperty("body");

      const listResult = await client.callTool({
        name: "list_docs",
        arguments: { tag: "sales", limit: 10 },
      });
      expect(payload(listResult).data).toMatchObject([{ id: created.id }]);
      expect((payload(listResult).data as unknown[])[0]).not.toHaveProperty(
        "body",
      );

      const searchResult = await client.callTool({
        name: "search_docs",
        arguments: { query: "enterprise", limit: 5 },
      });
      expect(payload(searchResult).data).toMatchObject([
        { slug: created.slug },
      ]);
      expect((payload(searchResult).data as unknown[])[0]).not.toHaveProperty(
        "body",
      );

      const getResult = await client.callTool({
        name: "get_doc",
        arguments: { slug: created.slug },
      });
      expect(payload(getResult).data).toMatchObject({
        id: created.id,
        body: "Enterprise price list",
      });

      const updateResult = await client.callTool({
        name: "update_doc",
        arguments: { id: created.id, body: "Wholesale prices", author: "Ana" },
      });
      expect(payload(updateResult).data).toMatchObject({
        id: created.id,
        changed_fields: ["body"],
      });
      expect(payload(updateResult).data).not.toHaveProperty("body");

      const revisionsResult = await client.callTool({
        name: "list_doc_revisions",
        arguments: { slug: created.slug },
      });
      expect(payload(revisionsResult).data).toMatchObject([
        { revision: 2, author: "Ana" },
        { revision: 1, author: "Martin" },
      ]);

      const revisionResult = await client.callTool({
        name: "get_doc_revision",
        arguments: { id: created.id, revision: 1 },
      });
      expect(payload(revisionResult).data).toMatchObject({
        body: "Enterprise price list",
      });

      const archiveResult = await client.callTool({
        name: "archive_doc",
        arguments: { slug: created.slug },
      });
      expect(payload(archiveResult).data).toMatchObject({ id: created.id });
      expect(
        (payload(archiveResult).data as { archived_at: string | null })
          .archived_at,
      ).not.toBeNull();

      const archivedList = await client.callTool({
        name: "list_docs",
        arguments: { archived: true },
      });
      expect(payload(archivedList).data).toMatchObject([{ id: created.id }]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns domain failures as consistent tool errors", async () => {
    const context = createTestContext();
    contexts.push(context);
    const server = createMcpServer(context.service);
    const client = new Client({ name: "slab-docs-test", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "get_doc",
        arguments: { slug: "missing" },
      });
      expect(result.isError).toBe(true);
      expect(payload(result)).toEqual({
        data: null,
        error: {
          code: "not_found",
          message: 'Document slug "missing" was not found.',
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not expose collection administration to a scoped agent", async () => {
    const context = createTestContext();
    contexts.push(context);
    const server = createMcpServer(context.service, {
      kind: "scoped",
      subject: "run:test",
      readCollectionIds: ["workspace"],
      writeCollectionIds: ["workspace"],
    });
    const client = new Client({ name: "scoped-agent", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const names = (await client.listTools()).tools.map(({ name }) => name);
      expect(names).not.toContain("ensure_collection");
      expect(names).not.toContain("archive_collection");
      expect(names).toHaveLength(8);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves tools through the authenticated Streamable HTTP endpoint", async () => {
    const context = createTestContext();
    contexts.push(context);
    const apiKey = "remote-mcp-key";
    const runtime = createApplication({
      service: context.service,
      apiKey,
      logger: { error: vi.fn() },
    });
    const httpServer = createHttpServer(runtime.app);
    await new Promise<void>((resolve) =>
      httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = httpServer.address() as AddressInfo;
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
      { authProvider: { token: () => Promise.resolve(apiKey) } },
    );
    const client = new Client({ name: "remote-test", version: "1.0.0" });
    const sourceId = "40000000-0000-4000-8000-000000000001";
    context.service.ensureCollection({
      id: sourceId,
      name: "Private source",
      kind: "source",
    });
    const privateDocument = context.service.create({
      title: "Private source document",
      body: "Scoped content",
      tags: [],
      collection_id: sourceId,
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(10);
      const result = await client.callTool({
        name: "create_doc",
        arguments: { title: "Remote document", body: "Created over HTTP" },
      });
      expect(payload(result).data).toMatchObject({ slug: "remote-document" });

      const issuedResponse = await fetch(
        `http://127.0.0.1:${port}/api/access-tokens`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subject: "run:remote-scoped",
            readCollectionIds: ["workspace"],
            writeCollectionIds: ["workspace"],
          }),
        },
      );
      const issued = (await issuedResponse.json()) as {
        data: { token: string };
      };
      const scopedTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { authProvider: { token: () => Promise.resolve(issued.data.token) } },
      );
      const scopedClient = new Client({
        name: "remote-scoped-test",
        version: "1.0.0",
      });
      await scopedClient.connect(scopedTransport);
      try {
        expect((await scopedClient.listTools()).tools).toHaveLength(8);
        const denied = await scopedClient.callTool({
          name: "get_doc",
          arguments: { id: privateDocument.id },
        });
        expect(denied.isError).toBe(true);
        expect(payload(denied).error?.code).toBe("not_found");
      } finally {
        await scopedClient.close();
      }
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
      await runtime.close();
    }
  });
});
