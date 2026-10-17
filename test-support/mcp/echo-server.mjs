#!/usr/bin/env node

import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined || request.id === null) return;

  switch (request.method) {
    case "initialize":
      respond(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "octo-runtime-echo", version: "1.0.0" }
      });
      break;
    case "ping":
      respond(request.id, {});
      break;
    case "tools/list":
      respond(request.id, {
        tools: [
          {
            name: "octo_echo",
            description: "Returns a deterministic Octo Runtime MCP integration marker.",
            inputSchema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false
            }
          }
        ]
      });
      break;
    case "tools/call": {
      const value = request.params?.arguments?.value;
      if (request.params?.name !== "octo_echo" || typeof value !== "string") {
        fail(request.id, -32602, "octo_echo requires a string value");
        break;
      }
      respond(request.id, {
        content: [{ type: "text", text: `octo-echo:${value}` }],
        isError: false
      });
      break;
    }
    default:
      fail(request.id, -32601, "method not found");
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
