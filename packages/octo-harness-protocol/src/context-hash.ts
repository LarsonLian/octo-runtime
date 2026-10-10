import { createHash } from "node:crypto";
import type { ContextEnvelope, McpStreamableHttpServer } from "./generated/protocol-types.js";
import { canonicalContext } from "./context.js";

export function contextHash(context: ContextEnvelope): string {
  return `sha256:${createHash("sha256").update(canonicalContext(context)).digest("hex")}`;
}

// Runtime-derived evidence binds reserved MCP servers without copying Run bearer secrets into metadata.
export function runMcpServerHash(server: McpStreamableHttpServer): string {
  const headers = Object.entries(server.headers ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return `sha256:${createHash("sha256").update(JSON.stringify([server.type, server.url, headers, server.required])).digest("hex")}`;
}
