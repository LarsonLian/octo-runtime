import { createHash, randomUUID } from "node:crypto";
import {
  CONTEXT_MAX_BYTES,
  assertContextEnvelope,
  assertMcpServers,
  contextItem,
  type ContextEnvelope,
  type ContextSelectionEntry,
  type McpStreamableHttpServer,
  type ResolvedExecutionPlan
} from "@mininglamp-oss/octo-harness-protocol";

export const TASK_MCP_SERVER = "octo_task";
export const TASK_MATERIAL_TOOL = "task_get_materials";
const MCP_PROTOCOL = "2025-03-26";
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface PreparedTaskMaterials {
  selections: ContextSelectionEntry[];
  refs: { resource_ref: string; task_id: string; task_version: number; handler_epoch: number; digest: string }[];
}

/** A client for the frozen run grant. Never accept endpoint or headers from tool arguments. */
export class TaskMcpClient {
  #server: McpStreamableHttpServer;
  #signal: AbortSignal;
  #session?: string;
  #protocol = MCP_PROTOCOL;

  constructor(server: McpStreamableHttpServer, signal: AbortSignal) {
    assertMcpServers({ [TASK_MCP_SERVER]: server });
    this.#server = structuredClone(server);
    this.#signal = signal;
  }

  async initialize(): Promise<void> {
    const result = object(await this.#request("initialize", {
      protocolVersion: MCP_PROTOCOL, capabilities: {}, clientInfo: { name: "octo-harness-task-bootstrap", version: "1.0.0" }
    }));
    if (typeof result.protocolVersion !== "string" || ![MCP_PROTOCOL, "2025-06-18", "2025-11-25"].includes(result.protocolVersion)) {
      throw new TypeError("TASK_MCP_PROTOCOL_UNSUPPORTED");
    }
    this.#protocol = result.protocolVersion;
    await this.#request("notifications/initialized", undefined, true);
  }

  async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = object(await this.#request("tools/call", { name: tool, arguments: args }));
    if (result.isError === true) throw new TypeError("TASK_MCP_TOOL_FAILED");
    if (result.structuredContent !== undefined) return object(result.structuredContent);
    if (!Array.isArray(result.content) || result.content.length !== 1) throw new TypeError("TASK_MCP_RESULT_INVALID");
    const content = object(result.content[0]);
    if (content.type !== "text" || typeof content.text !== "string") throw new TypeError("TASK_MCP_RESULT_INVALID");
    try { return object(JSON.parse(content.text)); } catch { throw new TypeError("TASK_MCP_RESULT_INVALID"); }
  }

  async #request(method: string, params?: Record<string, unknown>, notification = false): Promise<unknown> {
    const id = randomUUID();
    const response = await fetch(this.#server.url, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([this.#signal, AbortSignal.timeout(this.#server.toolTimeoutMs ?? 30_000)]),
      headers: {
        ...this.#server.headers, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": this.#protocol, ...(this.#session ? { "Mcp-Session-Id": this.#session } : {})
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, ...(params ? { params } : {}) })
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new TypeError(response.status === 401 || response.status === 403 ? "TASK_MCP_ACCESS_DENIED" : "TASK_MCP_UNAVAILABLE");
    }
    const session = response.headers.get("Mcp-Session-Id");
    if (session) this.#session = session;
    if (notification) { await response.body?.cancel(); return undefined; }
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("TASK_MCP_RESULT_INVALID");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > MAX_RESPONSE_BYTES) throw new TypeError("TASK_MCP_RESULT_BUDGET_EXCEEDED");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { throw new TypeError("TASK_MCP_RESULT_INVALID"); }
    if (body.jsonrpc !== "2.0" || body.id !== id || body.error !== undefined || body.result === undefined) {
      throw new TypeError("TASK_MCP_RESULT_INVALID");
    }
    return body.result;
  }
}

export function taskMcpServer(plan: ResolvedExecutionPlan): McpStreamableHttpServer {
  const server = plan.mcp_servers?.[TASK_MCP_SERVER];
  if (!server || server.type !== "streamable_http") throw new TypeError("TASK_MCP_REQUIRED");
  assertMcpServers({ [TASK_MCP_SERVER]: server });
  return server;
}

/** Resolve only the registered task operation; arbitrary MCP/CLI resources remain fail-closed. */
export async function prepareTaskMaterials(context: ContextEnvelope, plan: ResolvedExecutionPlan, signal: AbortSignal): Promise<PreparedTaskMaterials | undefined> {
  assertContextEnvelope(context);
  const resources = contextItem(context, "octo.content", "resources")?.payload.entries;
  if (!Array.isArray(resources) || resources.length === 0) return undefined;
  if (resources.length !== 1) throw new TypeError("TASK_MATERIAL_SCOPE_INVALID");
  const resource = object(resources[0]);
  const locator = object(resource.locator);
  if (resource.resolver !== "mcp" || locator.server_ref !== TASK_MCP_SERVER || locator.tool !== TASK_MATERIAL_TOOL) {
    throw new TypeError("CONTEXT_RESOLVER_UNAVAILABLE");
  }
  const params = object(resource.params);
  if (typeof params.task_id !== "string" || !params.task_id || Object.keys(params).some(key => !["task_id", "expected_version", "handler_epoch", "after_sequence", "known_task_version"].includes(key))) {
    throw new TypeError("TASK_MATERIAL_SCOPE_INVALID");
  }
  const client = new TaskMcpClient(taskMcpServer(plan), signal);
  await client.initialize();
  const result = await client.call(TASK_MATERIAL_TOOL, structuredClone(params));
  const task = object(result.task);
  if (task.id !== params.task_id || !positive(task.row_version) || !positive(task.handler_epoch)
    || (params.handler_epoch !== undefined && task.handler_epoch !== params.handler_epoch)) {
    throw new TypeError("TASK_MATERIAL_SCOPE_MISMATCH");
  }
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, "utf8") > CONTEXT_MAX_BYTES - 1024) throw new TypeError("TASK_MATERIAL_BUDGET_EXCEEDED");
  const resourceRef = String(resource.resource_ref);
  const ref = {
    resource_ref: resourceRef, task_id: String(task.id), task_version: Number(task.row_version),
    handler_epoch: Number(task.handler_epoch), digest: `sha256:${createHash("sha256").update(text).digest("hex")}`
  };
  return {
    selections: [{ resource_ref: resourceRef, text, source: { type: "task_material_snapshot", ...ref } }],
    refs: [ref]
  };
}

function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("TASK_MCP_RESULT_INVALID");
  return value as Record<string, unknown>;
}
