import {
  assertContextMcp,
  assertMcpServers,
  contextItem,
  type InvokeRequest,
  type McpServers
} from "@mininglamp-oss/octo-harness-protocol";
import { invocationEnvironment } from "./environment.js";

/** Only configuration strings expand. Replacement values are never scanned again. */
export function expandMcpValue(value: string, env: NodeJS.ProcessEnv, path: string): string {
  return value.replace(/\$\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    if (match.startsWith("$$")) return match.slice(1);
    if (!Object.hasOwn(env, name) || env[name] === undefined)
      throw new Error(`MCP_ENV_MISSING: ${path}: ${name}`);
    return env[name];
  });
}

export function invocationMcpServers(
  request: InvokeRequest,
  env = invocationEnvironment(request)
): McpServers {
  const payload = contextItem(request.context, "octo.execution", "mcp")?.payload ?? {
    mcpServers: {}
  };
  assertContextMcp(payload);
  const result = Object.fromEntries(
    Object.entries(payload.mcpServers).map(([name, server]) => {
      const text = (value: string, field: string) => expandMcpValue(value, env, `${name}.${field}`);
      const map = (values: Record<string, string>, field: string) =>
        Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, text(value, `${field}.${key}`)])
        );
      return [
        name,
        server.type === "stdio"
          ? {
              ...server,
              command: text(server.command, "command"),
              ...(server.args
                ? { args: server.args.map((value, i) => text(value, `args[${i}]`)) }
                : {}),
              ...(server.cwd !== undefined ? { cwd: text(server.cwd, "cwd") } : {}),
              ...(server.env ? { env: map(server.env, "env") } : {})
            }
          : {
              ...server,
              url: text(server.url, "url"),
              ...(server.headers ? { headers: map(server.headers, "headers") } : {})
            }
      ];
    })
  );
  assertMcpServers(result);
  for (const [name, server] of Object.entries(result)) {
    if (server.type === "streamable_http") {
      const url = new URL(server.url);
      if (url.username || url.password || url.hash || /[\r\n\0]/.test(server.url))
        throw new Error(`MCP_URL_INVALID: ${name}`);
    } else if (
      [server.command, server.cwd ?? "", ...(server.args ?? [])].some((value) =>
        value.includes("\0")
      )
    ) {
      throw new Error(`MCP_COMMAND_INVALID: ${name}`);
    }
  }
  return result;
}

/** Do not silently discard options a native transport cannot represent. */
export function assertMcpOptions(
  servers: McpServers,
  provider: string,
  supported: readonly string[]
): void {
  for (const [name, server] of Object.entries(servers)) {
    for (const field of [
      "required",
      "startupTimeoutMs",
      "toolTimeoutMs",
      ...(server.type === "stdio" ? ["cwd"] : [])
    ]) {
      if (Object.hasOwn(server, field) && !supported.includes(field))
        throw new Error(`MCP_OPTION_UNSUPPORTED: ${provider}: ${name}.${field}`);
    }
  }
}
