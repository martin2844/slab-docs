#!/usr/bin/env node

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const [baseUrl, apiKey, expectedSlug] = process.argv.slice(2);
if (!baseUrl || !apiKey || !expectedSlug) {
  console.error("Usage: mcp-smoke.mjs <base-url> <api-key> <expected-slug>");
  process.exit(2);
}

const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
  authProvider: { token: () => Promise.resolve(apiKey) }
});
const client = new Client({ name: "slab-docs-container-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  const result = await client.callTool({ name: "get_doc", arguments: { slug: expectedSlug } });
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text || !text.includes("Survives container replacement")) {
    throw new Error(`MCP get_doc did not return ${expectedSlug}`);
  }
  console.log("Slab Docs MCP persistence check passed.");
} finally {
  await client.close();
}
