import { assertMcpServers, type McpServers } from "@mininglamp-oss/octo-harness-protocol";

const schema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const keys = new Set(["type", "url", "command", "args", "cwd", "env", "staticEnv", "headers", "staticHeaders", "disabled", "disabledTools", "timeout", "startupTimeoutMs", "toolTimeoutMs", "required"]);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function stringMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value) || Object.values(value).some(item => typeof item !== "string")) throw new TypeError("MCP_STRING_MAP_INVALID");
  return { ...value } as Record<string, string>;
}
function mergeMaps(staticValue: unknown, dynamicValue: unknown, headers = false): Record<string, string> {
  const result: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const source of [stringMap(staticValue), stringMap(dynamicValue)]) {
    for (const [key, value] of Object.entries(source)) {
      const normalized = headers ? key.toLowerCase() : key;
      if (headers && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n\0]/.test(value))) throw new TypeError("MCP_HEADER_INVALID");
      if (seen.has(normalized)) throw new TypeError("MCP_CONFIG_MAP_CONFLICT");
      seen.set(normalized, key);
      Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return result;
}

/** External connector syntax ends here; provider adapters consume the canonical contract. */
export function normalizeAgentPluginMcpServer(value: unknown): McpServers[string] | undefined {
  if (!object(value)) throw new TypeError("MCP_CONFIG_INVALID");
  if (value.disabled !== undefined && typeof value.disabled !== "boolean") throw new TypeError("MCP_DISABLED_INVALID");
  if (value.disabled === true) return undefined;
  if (Object.keys(value).some(key => !keys.has(key))) throw new TypeError("MCP_CONFIG_FIELD_UNSUPPORTED");
  if (value.disabledTools !== undefined && (!Array.isArray(value.disabledTools) || value.disabledTools.length > 0)) throw new TypeError("MCP_TOOL_FILTER_UNSUPPORTED");
  if (value.timeout !== undefined && value.toolTimeoutMs !== undefined) throw new TypeError("MCP_TIMEOUT_CONFLICT");
  const type = value.type ?? (value.url !== undefined ? "streamable_http" : "stdio");
  const timing = {
    ...(value.required !== undefined ? { required: value.required } : {}),
    ...(value.startupTimeoutMs !== undefined ? { startupTimeoutMs: value.startupTimeoutMs } : {}),
    ...(value.toolTimeoutMs !== undefined || value.timeout !== undefined ? { toolTimeoutMs: value.toolTimeoutMs ?? value.timeout } : {})
  };
  let server: unknown;
  if (type === "stdio") {
    if (["url", "headers", "staticHeaders"].some(key => value[key] !== undefined)) throw new TypeError("MCP_TRANSPORT_FIELDS_CONFLICT");
    const env = mergeMaps(value.staticEnv, value.env);
    server = { type, command: value.command, ...timing, ...(value.args !== undefined ? { args: value.args } : {}), ...(value.cwd !== undefined ? { cwd: value.cwd } : {}), ...(Object.keys(env).length ? { env } : {}) };
  } else if (["streamable_http", "streamable-http", "streamableHttp", "http"].includes(String(type))) {
    if (["command", "args", "cwd", "env", "staticEnv"].some(key => value[key] !== undefined)) throw new TypeError("MCP_TRANSPORT_FIELDS_CONFLICT");
    const headers = mergeMaps(value.staticHeaders, value.headers, true);
    if (typeof value.url !== "string") throw new TypeError("MCP_URL_INVALID");
    let url: URL;
    try { url = new URL(value.url); } catch { throw new TypeError("MCP_URL_INVALID"); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError("MCP_URL_INVALID");
    server = { type: "streamable_http", url: value.url, ...timing, ...(Object.keys(headers).length ? { headers } : {}) };
  } else throw new TypeError("MCP_TRANSPORT_UNSUPPORTED");
  assertMcpServers({ server });
  return server as McpServers[string];
}

export function normalizeAgentPluginMcpConfig(document: unknown): McpServers {
  if (!object(document) || !object(document.mcpServers) || Object.keys(document).some(key => !["$schema", "mcpServers"].includes(key))
    || document.$schema !== undefined && document.$schema !== schema) throw new TypeError("MCP_DOCUMENT_INVALID");
  const servers: McpServers = {};
  for (const [name, value] of Object.entries(document.mcpServers)) {
    const server = normalizeAgentPluginMcpServer(value);
    if (server !== undefined) {
      // Enabled names retain their identity for Run grants and frozen hashes.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new TypeError("MCP_NAME_UNSUPPORTED");
      servers[name] = server;
    }
  }
  assertMcpServers(servers);
  return servers;
}

export function canonicalMcpServers(servers: McpServers | undefined): McpServers {
  return normalizeAgentPluginMcpConfig({ mcpServers: servers ?? {} });
}
