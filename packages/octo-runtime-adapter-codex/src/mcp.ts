import { randomUUID } from "node:crypto";
import { invocationMcpServers, type InvokeRequest } from "@mininglamp-oss/octo-runtime-adapter-sdk";

/** Header secrets travel in the subprocess environment, never argv or persisted config. */
export function codexMcpConfig(request: InvokeRequest, env: NodeJS.ProcessEnv) {
  const prefix = `OCTO_MCP_${randomUUID().replaceAll("-", "")}`;
  const servers = invocationMcpServers(request, env);
  const secrets: NodeJS.ProcessEnv = {};
  const native = Object.fromEntries(
    Object.entries(servers).map(([name, server], index) => {
      const entry: Record<string, unknown> = {};
      if (server.type === "stdio") {
        entry.command = server.command;
        if (server.args) entry.args = server.args;
        if (server.cwd) entry.cwd = server.cwd;
        if (server.env) entry.env = server.env;
      } else {
        entry.url = server.url;
        entry.env_http_headers = Object.fromEntries(
          Object.entries(server.headers ?? {}).map(([key, value], header) => {
            const variable = `${prefix}_${index}_${header}`;
            secrets[variable] = value;
            return [key, variable];
          })
        );
      }
      if (server.required !== undefined) entry.required = server.required;
      if (server.startupTimeoutMs !== undefined)
        entry.startup_timeout_sec = server.startupTimeoutMs / 1000;
      if (server.toolTimeoutMs !== undefined) entry.tool_timeout_sec = server.toolTimeoutMs / 1000;
      return [name, entry];
    })
  );
  return { servers: native, env: secrets };
}
