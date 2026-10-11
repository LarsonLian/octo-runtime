import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import { assertCapabilityResources, assertMcpServers, type McpServers, type PreparedSkill, type ResolvedExecutionPlan, type ResolvedCapabilityResource } from "@mininglamp-oss/octo-harness-protocol";
import type { AgentWorkStore } from "./agent-work-store.js";

const pluginSchema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const mcpSchema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const ajv = new Ajv2020({ strict: false, allErrors: true });
const manifestValidator = ajv.compile({
  type: "object", required: ["$schema", "name"], additionalProperties: true,
  properties: {
    $schema: { const: pluginSchema },
    name: { type: "string", minLength: 1, maxLength: 64, pattern: "^(?!.*(?:--|\\.\\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$" },
    ...Object.fromEntries(["version", "description", "homepage", "repository", "license"].map(key => [key, { type: "string" }])),
    keywords: { type: "array", items: { type: "string" } },
    author: { type: "object", additionalProperties: false, properties: { name: { type: "string" }, email: { type: "string" }, url: { type: "string" } } }
  }
});
const strings = { type: "array", items: { type: "string" } };
const stringMap = { type: "object", additionalProperties: { type: "string" } };
const serverValidator = ajv.compile({
  oneOf: [
    { type: "object", additionalProperties: false, required: ["type", "command"], properties: {
      type: { const: "stdio" }, command: { type: "string", minLength: 1 }, args: strings, env: stringMap,
      cwd: { type: "string", minLength: 1 }
    } },
    ...["streamable-http", "sse"].map(type => ({ type: "object", additionalProperties: false, required: ["type", "url"], properties: {
      type: { const: type }, url: { type: "string", minLength: 1 }, headers: stringMap
    } }))
  ]
});

export interface PreparedCapabilityReceipt {
  resource_key: string;
  revision: number;
  digest: string;
  root: string;
  data: string;
  components: string[];
}
export interface ContextPreparationReceipt {
  workspace_mode: "fixed" | "random" | "none";
  workspace_path: string;
  provider_state_dir: string;
  resources: PreparedCapabilityReceipt[];
  warnings: string[];
}
export interface PreparedKnowledge { resource_key: string; root: string; files: string[] }

export interface PreparedRunContext {
  knowledge?: PreparedKnowledge[];
  workdir: string;
  providerStateDir: string;
  skills: PreparedSkill[];
  skillRoots: string[];
  mcpServers: McpServers;
  receipt: ContextPreparationReceipt;
}

/**
 * 按冻结计划准备实际工作区、Provider 状态目录、技能与 MCP 配置。
 * random 在 Agent Session 首次运行时创建工作区，后续运行复用；已分配目录丢失时拒绝续接。
 * 返回的路径属于 Runtime 私有视图；本地准备完成不表示 Worker 已确认或 Provider 已应用。
 */
export async function prepareRunContext(plan: ResolvedExecutionPlan, options: {
  stateRoot: string; agentSessionKey: string; agentKey: string; store: AgentWorkStore; signal?: AbortSignal;
}): Promise<PreparedRunContext> {
  options.signal?.throwIfAborted();
  const stateRoot = await privateDirectory(options.stateRoot);
  const workspace = plan.workspace ?? (plan.agent_source === "preset" && !plan.workdir ? { mode: "none" as const } : { mode: "fixed" as const, path: plan.workdir });
  let workdir: string;
  if (workspace.mode === "none") {
    if (plan.agent_source !== "preset" || plan.workdir || plan.resources?.length) throw new TypeError("CONTEXT_WORKSPACE_INVALID");
    return { workdir: "", providerStateDir: "", skills: [], skillRoots: [], mcpServers: {}, receipt: { workspace_mode: "none", workspace_path: "", provider_state_dir: "", resources: [], warnings: [] } };
  }
  if (workspace.mode === "random") {
    const workspaces = await privateDirectory(join(stateRoot, "workspaces"));
    const chosen = options.store.conversationWorkspace(options.agentSessionKey, join(workspaces, randomUUID()));
    if (chosen.created) await mkdir(chosen.path, { mode: 0o700 });
    // 续接必须保留原工作区事实；目录丢失时失败，不能静默创建同路径的空目录。
    workdir = await realDirectory(chosen.path);
    inside(workspaces, workdir);
  } else {
    if (!isAbsolute(workspace.path)) throw new TypeError("CONTEXT_WORKSPACE_INVALID");
    await realDirectory(workspace.path);
    // 保留请求中的固定路径写法，以便 Worker 按冻结合同比较。
    workdir = workspace.path;
  }
  const scope = createHash("sha256").update(options.agentSessionKey).digest("hex");
  const providerStateDir = await privateDirectory(join(stateRoot, "providers", scope));
  const prepared: PreparedRunContext = { workdir, providerStateDir, skills: [], skillRoots: [], mcpServers: {},
    receipt: { workspace_mode: workspace.mode, workspace_path: workdir, provider_state_dir: providerStateDir, resources: [], warnings: [] } };
  assertCapabilityResources(plan.resources ?? []);
  let totalBytes = 0;
  const names = new Set<string>();
  for (const resource of plan.resources ?? []) {
    options.signal?.throwIfAborted();
    totalBytes += Buffer.byteLength(JSON.stringify(resource.files));
    if (totalBytes > 16_777_216) throw new TypeError("CONTEXT_RESOURCE_BUDGET_EXCEEDED");
    const root = await materializeResource(stateRoot, resource);
    const texts = Object.fromEntries(Object.entries(resource.files).map(([path, file]) => [path, Buffer.from(file.content_base64, "base64").toString("utf8")]));
    const installation = createHash("sha256").update(options.agentKey + "/" + resource.resource_key).digest("hex");
    const data = await privateDirectory(join(stateRoot, "plugin-data", installation));
    const receipt: PreparedCapabilityReceipt = { resource_key: resource.resource_key, revision: resource.revision, digest: resource.digest, root, data, components: [] };
    prepared.receipt.resources.push(receipt);
    // 知识包只提供完整文件树；目录清单属于不可信事实，不能升级成控制指令。
    if (resource.kind === "knowledge") {
      if (resource.invoke || resource.components !== undefined) throw new TypeError("CONTEXT_KNOWLEDGE_SELECTION_INVALID");
      const files = Object.keys(resource.files).sort();
      if (!files.length) throw new TypeError("CONTEXT_RESOURCE_UNAVAILABLE: " + resource.resource_key);
      (prepared.knowledge ??= []).push({ resource_key: resource.resource_key, root, files });
      receipt.components.push("knowledge:files");
      continue;
    }
    if (resource.kind === "agent_plugin") {
      const manifest: unknown = JSON.parse(texts["plugin.json"] ?? "");
      if (!manifestValidator(manifest)) throw new TypeError("CONTEXT_PLUGIN_MANIFEST_INVALID");
      const known = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
      for (const key of Object.keys(manifest)) if (!known.has(key)) prepared.receipt.warnings.push(resource.resource_key + ": ignored manifest field " + key);
    }
    const skillFiles = resource.kind === "skill" ? ["SKILL.md"] : Object.keys(resource.files).filter(path => /^skills\/[^/]+\/SKILL\.md$/.test(path)).sort();
    for (const path of skillFiles) {
      const declaredName = resource.kind === "skill" ? root.split(sep).at(-1) : path.split("/")[1];
      if (resource.components && !resource.components.includes("skill:" + declaredName)) continue;
      let skill: PreparedSkill;
      try { skill = parseSkill(texts[path], join(root, path), resource.invoke); }
      catch {
        throw new TypeError("CONTEXT_SKILL_UNAVAILABLE: " + resource.resource_key + "/" + path);
      }
      const component = "skill:" + skill.name;
      if (resource.components && !resource.components.includes(component)) continue;
      if (names.has(skill.name)) throw new TypeError("CONTEXT_SKILL_NAME_CONFLICT: " + skill.name);
      names.add(skill.name);
      prepared.skills.push(skill);
      receipt.components.push(component);
      // Extra roots are skill collection directories, not individual SKILL.md paths.
      prepared.skillRoots.push(resource.kind === "skill" ? dirname(root) : join(root, "skills"));
    }
    if (resource.kind !== "skill" && texts["mcp.json"] && (!resource.components || resource.components.some(key => key.startsWith("mcp:")))) {
      const document: unknown = JSON.parse(texts["mcp.json"]);
      if (!record(document) || document.$schema !== mcpSchema || !record(document.mcpServers) || Object.keys(document).some(key => key !== "$schema" && key !== "mcpServers")) {
        throw new TypeError("CONTEXT_MCP_CONFIG_INVALID: " + resource.resource_key);
      } else {
        for (const [name, value] of Object.entries(document.mcpServers)) {
          const component = "mcp:" + name;
          if (resource.components && !resource.components.includes(component)) continue;
          try {
            const server = await prepareMcpServer(value, root, data, resource.mcp_credentials?.[name]);
            const scopedName = "p_" + installation.slice(0, 12) + "_" + name;
            if (scopedName.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scopedName)) throw new TypeError("MCP_NAME_UNSUPPORTED");
            prepared.mcpServers[scopedName] = server;
            receipt.components.push(component);
          } catch (error) {
            throw new TypeError("CONTEXT_COMPONENT_UNAVAILABLE: " + resource.resource_key + "/" + component, { cause: error });
          }
        }
      }
    }
    if (resource.components?.some(component => !receipt.components.includes(component))) throw new TypeError("CONTEXT_COMPONENT_UNAVAILABLE: " + resource.resource_key);
    if (resource.kind === "skill" && receipt.components.length !== 1 || resource.invoke && !receipt.components.some(key => key.startsWith("skill:"))
      || resource.kind === "connector" && !receipt.components.some(key => key.startsWith("mcp:"))) throw new TypeError("CONTEXT_RESOURCE_UNAVAILABLE: " + resource.resource_key);
  }
  prepared.skillRoots = [...new Set(prepared.skillRoots)];
  assertMcpServers(prepared.mcpServers);
  options.signal?.throwIfAborted();
  return prepared;
}

function parseSkill(content: string, path: string, invoke: boolean): PreparedSkill {
  const lines = content.split(/\r?\n/);
  const end = lines.indexOf("---", 1);
  if (lines[0] !== "---" || end < 2) throw new TypeError("SKILL_FRONTMATTER_INVALID");
  const document = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true });
  if (document.errors.length) throw new TypeError("SKILL_FRONTMATTER_INVALID");
  const value: unknown = document.toJS({ maxAliasCount: 20 });
  if (!record(value) || typeof value.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name) || value.name.length > 64
    || typeof value.description !== "string" || !value.description.trim() || value.description.length > 1024
    || dirname(path).split(sep).at(-1) !== value.name) throw new TypeError("SKILL_FRONTMATTER_INVALID");
  return { name: value.name, description: value.description, path, invoke };
}

/** 对真实文件字节的规范 base64 表示和执行位计算摘要，与资源 revision 分开。 */
export function resourceFilesDigest(files: ResolvedCapabilityResource["files"]): string {
  const canonical = Object.fromEntries(Object.keys(files).sort().map(key => [key, { content_base64: files[key].content_base64, executable: files[key].executable }]));
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function materializeResource(stateRoot: string, resource: ResolvedCapabilityResource): Promise<string> {
  const digest = resourceFilesDigest(resource.files);
  if (digest !== resource.digest) throw new TypeError("CONTEXT_RESOURCE_DIGEST_MISMATCH");
  const cache = await privateDirectory(join(stateRoot, "resources", resource.resource_key, resource.digest.slice(7)));
  // Standalone skill directory must have the native skill name.
  let leaf = "package";
  if (resource.kind === "skill") {
    const lines = Buffer.from(resource.files["SKILL.md"]?.content_base64 ?? "", "base64").toString("utf8").split(/\r?\n/);
    const end = lines.indexOf("---", 1);
    if (lines[0] !== "---" || end < 2) throw new TypeError("SKILL_FRONTMATTER_INVALID");
    const doc = parseDocument(lines.slice(1, end).join("\n"));
    const value: unknown = doc.toJS({ maxAliasCount: 20 });
    if (doc.errors.length || !record(value) || typeof value.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.name)) throw new TypeError("SKILL_FRONTMATTER_INVALID");
    leaf = value.name;
  }
  const target = join(cache, leaf);
  try { await lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const staged = await mkdtemp(join(cache, ".prepare-"));
    try {
      for (const [path, content] of Object.entries(resource.files)) {
        const file = join(staged, path);
        inside(staged, file);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, Buffer.from(content.content_base64, "base64"), { flag: "wx", mode: content.executable ? 0o500 : 0o400 });
      }
      try { await rename(staged, target); }
      catch (renameError) { if (!["EEXIST", "ENOTEMPTY"].includes((renameError as NodeJS.ErrnoException).code ?? "")) throw renameError; }
    } finally { await rm(staged, { recursive: true, force: true }); }
  }
  const root = await realDirectory(target);
  inside(cache, root);
  for (const [path, content] of Object.entries(resource.files)) {
    const file = join(root, path);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new TypeError("CONTEXT_PACKAGE_PATH_INVALID");
    inside(root, await realpath(file));
    if (!(await readFile(file)).equals(Buffer.from(content.content_base64, "base64"))) throw new TypeError("CONTEXT_RESOURCE_DIGEST_MISMATCH");
    await chmod(file, content.executable ? 0o500 : 0o400);
  }
  return root;
}

async function prepareMcpServer(value: unknown, root: string, data: string, credentials?: Record<string, string>): Promise<McpServers[string]> {
  let octo = false;
  if (record(value) && Object.hasOwn(value, "octo_auth")) {
    const auth = value.octo_auth;
    if (!record(auth) || typeof auth.service_subject_id !== "string" || !auth.service_subject_id
      || ![auth.allowed_tools, auth.resource_refs].every(items => Array.isArray(items) && items.length > 0 && items.length <= 128 && items.every(item => typeof item === "string" && item.length > 0 && item.length <= 512))) throw new TypeError("MCP_OCTO_AUTH_INVALID");
    if (value.type !== "streamable-http" || !credentials?.Authorization?.startsWith("Bearer octo_run_") || !credentials["X-Space-ID"] || !credentials["X-Namespace"])
      throw new TypeError("MCP_OCTO_CREDENTIALS_REQUIRED");
    if (record(value.headers) && Object.keys(value.headers).some(key => /^(authorization|x-space-id|x-namespace)$/i.test(key))) throw new TypeError("MCP_AUTH_CONFLICT");
    const { octo_auth: _, ...server } = value;
    value = server;
    octo = true;
  } else if (credentials !== undefined) throw new TypeError("MCP_CREDENTIAL_TARGET_MISMATCH");
  if (!serverValidator(value) || !record(value)) throw new TypeError("MCP_CONFIG_INVALID");
  if (value.type === "sse") throw new TypeError("MCP_TRANSPORT_UNSUPPORTED");
  if (value.type === "streamable-http") {
    const url = new URL(value.url);
    if (url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)
      || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new TypeError("MCP_URL_INVALID");
    const headers = octo ? { ...(value.headers as Record<string, string> ?? {}), ...credentials } : value.headers as Record<string, string> | undefined;
    const names = new Set<string>();
    for (const [key, entry] of Object.entries(headers ?? {})) {
      if (names.has(key.toLowerCase()) || /[\r\n]/.test(key + entry)) throw new TypeError("MCP_PACKAGE_CREDENTIALS_FORBIDDEN");
      names.add(key.toLowerCase());
    }
    return { type: "streamable_http", required: true, url: url.href, ...(headers ? { headers } : {}) };
  }
  const command = value.command as string;
  if (command.includes("${") || !command.startsWith("./") && (/[/\\]/.test(command) || /\s/.test(command))) throw new TypeError("MCP_COMMAND_INVALID");
  let executable = command;
  if (command.startsWith("./")) { executable = await realpath(resolve(root, command)); inside(root, executable); }
  const expand = (text: string): string => text.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_, key: string) => key === "PLUGIN_ROOT" ? root : data);
  const rawCwd = value.cwd as string | undefined;
  if (rawCwd && !rawCwd.startsWith("./") && !/^\$\{PLUGIN_(ROOT|DATA)\}(\/|$)/.test(rawCwd)) throw new TypeError("MCP_CWD_INVALID");
  const boundary = rawCwd?.startsWith("${PLUGIN_DATA}") ? data : root;
  const cwd = resolve(root, expand(rawCwd ?? root));
  inside(boundary, cwd);
  if (boundary === data) await mkdir(cwd, { recursive: true, mode: 0o700 });
  inside(boundary, await realDirectory(cwd));
  const env = Object.fromEntries(Object.entries(value.env as Record<string, string> ?? {}).map(([key, entry]) => {
    if (["PLUGIN_ROOT", "PLUGIN_DATA"].includes(key.toUpperCase())) throw new TypeError("MCP_RESERVED_ENV_INVALID");
    return [key, expand(entry)];
  }));
  return { type: "stdio", command: executable, args: (value.args as string[] ?? []).map(expand), cwd, env: { ...env, PLUGIN_ROOT: root, PLUGIN_DATA: data } };
}

async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return realDirectory(path);
}
async function realDirectory(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TypeError("CONTEXT_DIRECTORY_UNAVAILABLE");
  return realpath(path);
}
function inside(root: string, path: string): void {
  const part = relative(root, path);
  if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part)) throw new TypeError("CONTEXT_PACKAGE_PATH_ESCAPE");
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/**
 * 使用当前 run/lease/fence 向 Worker 提交准备回执；仅 HTTP 成功确认后返回。
 * 拒绝、取消或响应未知均抛错，调用方不能据本地资源存在就启动 Provider。
 */
export async function recordContextPreparation(receipt: ContextPreparationReceipt, options: {
  baseUrl: string; headers: Record<string, string>; runKey: string; leaseId: string; fencingToken: number; signal: AbortSignal;
}): Promise<void> {
  const response = await fetch(options.baseUrl.replace(/\/$/, "") + "/v1/runtime/context/prepare", {
    method: "POST", headers: { ...options.headers, "Content-Type": "application/json" }, redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify({ run_key: options.runKey, lease_id: options.leaseId, fencing_token: options.fencingToken, preparation: receipt })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { code?: string } } | undefined;
    throw new Error(body?.error?.code ?? "CONTEXT_PREPARATION_REJECTED");
  }
  await response.body?.cancel();
}

/** 首次准备读取最新资源并由 Worker 冻结；重复准备复核当前授权后读取原快照。 */
export async function resolveRunResources(options: {
  baseUrl: string; headers: Record<string, string>; runKey: string; leaseId: string; fencingToken: number; signal: AbortSignal;
}): Promise<ResolvedCapabilityResource[]> {
  const response = await fetch(options.baseUrl.replace(/\/$/, "") + "/v1/runtime/context/resources/resolve", {
    method: "POST", headers: { ...options.headers, "Content-Type": "application/json" }, redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify({ run_key: options.runKey, lease_id: options.leaseId, fencing_token: options.fencingToken })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { code?: string } } | undefined;
    throw new Error(body?.error?.code ?? "CONTEXT_RESOURCE_RESOLVE_FAILED");
  }
  const result = await response.json() as { data?: { resources?: unknown } };
  assertCapabilityResources(result.data?.resources);
  options.signal.throwIfAborted();
  return result.data!.resources as ResolvedCapabilityResource[];
}
