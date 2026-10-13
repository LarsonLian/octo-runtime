import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertContextEnvelope,
  assertMcpServers,
  contextHash,
  contextItem,
  type ContextEnvelope,
  type ContextSelectionEntry,
  type McpStreamableHttpServer
} from "@mininglamp-oss/octo-harness-protocol";

export const TASK_MCP_SERVER = "octo_task";
export const TASK_MATERIAL_TOOL = "task_get_materials";
const MCP_PROTOCOL = "2025-03-26";
// 这是内部受权材料的传输上限，不是公开 Context 信封或模型 token 预算。
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 16 * 1024 * 1024;
const BINDING_RETRY_MS = 250;
const BINDING_RETRY_DEADLINE_MS = 10_000;

export interface PreparedTaskMaterials {
  selections: ContextSelectionEntry[];
  refs: { resource_ref: string; task_id: string; task_version: number; handler_epoch: number; digest: string }[];
}

export interface TaskMaterialSnapshotStore {
  getTaskMaterialSnapshot(runId: string, hash: string): PreparedTaskMaterials | undefined;
  putTaskMaterialSnapshot(runId: string, hash: string, value: PreparedTaskMaterials): void;
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
    const params = { name: tool, arguments: structuredClone(args) };
    let retryDeadline: AbortSignal | undefined;
    let signal = this.#signal;
    try {
      while (true) {
        signal.throwIfAborted();
        const result = object(await this.#request("tools/call", params, false, signal));
        if (result.isError === true) {
          const content = result.structuredContent;
          const error = content && typeof content === "object" && !Array.isArray(content)
            ? (content as Record<string, unknown>).error : undefined;
          const pending = error && typeof error === "object" && !Array.isArray(error)
            && (error as Record<string, unknown>).code === "TASK_RESULT_BINDING_PENDING";
          if (!pending || ![TASK_MATERIAL_TOOL, "task_authorize_material_snapshot"].includes(tool)) {
            // 只传递可信结构化业务错误码；不把服务端详情、URL 或凭据写入公共收据。
            const code = error && typeof error === "object" && !Array.isArray(error) ? (error as Record<string, unknown>).code : undefined;
            if (typeof code === "string" && /^(TASK|DISCUSSION)_[A-Z_]{1,80}$/.test(code)) throw new TypeError(code);
            throw new TypeError("TASK_MCP_TOOL_FAILED");
          }
          // Run admission can precede Access's registration ACK. Repeat only this read with its frozen grant and arguments.
          retryDeadline ??= AbortSignal.timeout(BINDING_RETRY_DEADLINE_MS);
          signal = AbortSignal.any([this.#signal, retryDeadline]);
          await delay(BINDING_RETRY_MS, undefined, { signal });
          continue;
        }
        if (result.structuredContent !== undefined) return object(result.structuredContent);
        if (!Array.isArray(result.content) || result.content.length !== 1) throw new TypeError("TASK_MCP_RESULT_INVALID");
        const content = object(result.content[0]);
        if (content.type !== "text" || typeof content.text !== "string") throw new TypeError("TASK_MCP_RESULT_INVALID");
        try { return object(JSON.parse(content.text)); } catch { throw new TypeError("TASK_MCP_RESULT_INVALID"); }
      }
    } catch (error) {
      this.#signal.throwIfAborted();
      if (retryDeadline?.aborted) throw new TypeError("TASK_RESULT_BINDING_PENDING", { cause: error });
      throw error;
    }
  }

  async #request(method: string, params?: Record<string, unknown>, notification = false, signal = this.#signal): Promise<unknown> {
    const id = randomUUID();
    const response = await fetch(this.#server.url, {
      method: "POST", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.#server.toolTimeoutMs ?? 30_000)]),
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
        const chunk: unknown = next.value;
        if (!(chunk instanceof Uint8Array)) throw new TypeError("TASK_MCP_RESULT_INVALID");
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) throw new TypeError("TASK_MCP_RESULT_BUDGET_EXCEEDED");
        chunks.push(chunk);
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

/**
 * 仅通过注册的任务 MCP 操作读取材料，并固定实读版本、handler epoch、正文和 digest。
 * 命中本地快照后仍使用当前 Run 授权重新校验；恢复复用原正文，不读取新 latest。
 * 快照不一致或授权失效时抛错，不将任意 MCP/CLI 调用作为备用解析器。
 */
export async function prepareTaskMaterials(context: ContextEnvelope, server: McpStreamableHttpServer | undefined, signal: AbortSignal, snapshot?: {
  runId: string; store: TaskMaterialSnapshotStore;
}): Promise<PreparedTaskMaterials | undefined> {
  signal.throwIfAborted();
  assertContextEnvelope(context);
  const entries = contextItem(context, "octo.content", "references")?.payload.entries;
  const resources = Array.isArray(entries) ? entries : [];
  if (!Array.isArray(resources) || resources.length === 0) return undefined;
  if (resources.length !== 1) throw new TypeError("TASK_MATERIAL_SCOPE_INVALID");
  const resource = object(resources[0]);
  const locator = object(resource.locator);
  if (resource.resolver !== "mcp" || locator.server_ref !== TASK_MCP_SERVER || locator.tool !== TASK_MATERIAL_TOOL) {
    throw new TypeError("CONTEXT_RESOLVER_UNAVAILABLE");
  }
  const params = object(resource.params);
  if (typeof params.task_id !== "string" || !params.task_id || Object.keys(params).some(key => !["task_id", "expected_version", "handler_epoch"].includes(key))) {
    throw new TypeError("TASK_MATERIAL_SCOPE_INVALID");
  }
  if (!server) throw new TypeError("BUSINESS_SERVICE_BINDING_REQUIRED");
  assertMcpServers({ task: server });
  const client = new TaskMcpClient(server, signal);
  await client.initialize();
  const hash = contextHash(context);
  const cached = snapshot?.store.getTaskMaterialSnapshot(snapshot.runId, hash);
  if (cached) {
    assertTaskMaterialSnapshot(cached, String(resource.resource_ref), params);
    const ref = cached.refs[0];
    const authorized = await client.call("task_authorize_material_snapshot", {
      task_id: ref.task_id, task_version: ref.task_version, handler_epoch: ref.handler_epoch, digest: ref.digest
    });
    if (authorized.authorized !== true || authorized.task_id !== ref.task_id || authorized.task_version !== ref.task_version
      || authorized.handler_epoch !== ref.handler_epoch || authorized.digest !== ref.digest) {
      throw new TypeError("TASK_MATERIAL_SNAPSHOT_UNAUTHORIZED");
    }
    signal.throwIfAborted();
    return structuredClone(cached);
  }
  const result = await client.call(TASK_MATERIAL_TOOL, structuredClone(params));
  const task = object(result.task);
  if (task.task_id !== params.task_id || !positive(task.row_version) || !positive(task.handler_epoch)
    || (params.handler_epoch !== undefined && task.handler_epoch !== params.handler_epoch)
    || (params.expected_version !== undefined && task.row_version !== params.expected_version)) {
    throw new TypeError("TASK_MATERIAL_SCOPE_MISMATCH");
  }
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, "utf8") > MAX_MATERIAL_BYTES) throw new TypeError("TASK_MATERIAL_BUDGET_EXCEEDED");
  const resourceRef = String(resource.resource_ref);
  const ref = {
    resource_ref: resourceRef, task_id: String(task.task_id), task_version: Number(task.row_version),
    handler_epoch: Number(task.handler_epoch), digest: `sha256:${createHash("sha256").update(text).digest("hex")}`
  };
  const prepared: PreparedTaskMaterials = {
    selections: [{ resource_ref: resourceRef, text, source: { type: "task_material_snapshot", ...ref } }],
    refs: [ref]
  };
  signal.throwIfAborted();
  if (snapshot) snapshot.store.putTaskMaterialSnapshot(snapshot.runId, hash, prepared);
  return prepared;
}

function assertTaskMaterialSnapshot(value: PreparedTaskMaterials, resourceRef: string, params: Record<string, unknown>): void {
  if (!Array.isArray(value.refs) || value.refs.length !== 1 || !Array.isArray(value.selections) || value.selections.length !== 1) {
    throw new TypeError("TASK_MATERIAL_SNAPSHOT_INVALID");
  }
  const ref = value.refs[0], selection = value.selections[0];
  if (ref.resource_ref !== resourceRef || ref.task_id !== params.task_id || !positive(ref.task_version) || !positive(ref.handler_epoch)
    || (params.handler_epoch !== undefined && ref.handler_epoch !== params.handler_epoch)
    || (params.expected_version !== undefined && ref.task_version !== params.expected_version)
    || selection.resource_ref !== resourceRef || typeof selection.text !== "string"
    || Buffer.byteLength(selection.text, "utf8") > MAX_MATERIAL_BYTES
    || ref.digest !== `sha256:${createHash("sha256").update(selection.text).digest("hex")}`) {
    throw new TypeError("TASK_MATERIAL_SNAPSHOT_INVALID");
  }
  const task = object(object(JSON.parse(selection.text)).task);
  if (task.task_id !== ref.task_id || task.row_version !== ref.task_version || task.handler_epoch !== ref.handler_epoch) {
    throw new TypeError("TASK_MATERIAL_SNAPSHOT_INVALID");
  }
}

function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0; }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("TASK_MCP_RESULT_INVALID");
  return value as Record<string, unknown>;
}
