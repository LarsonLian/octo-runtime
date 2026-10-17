import { createServer } from "node:http";

/** Stateless Streamable HTTP fixture. Records only synthetic test credentials. */
export async function startMcpHttpServer() {
  const receipts = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const message = JSON.parse(body);
      receipts.push({
        method: message.method,
        authorization: req.headers.authorization,
        literal: req.headers["x-literal"],
        params: message.params
      });
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "octo-mcp-context-test", version: "1" }
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "octo_echo",
                    description: "Echo a test value",
                    inputSchema: {
                      type: "object",
                      properties: { value: { type: "string" } },
                      required: ["value"],
                      additionalProperties: false
                    }
                  }
                ]
              }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: `octo-echo:${message.params.arguments.value}` }] }
              : {};
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    receipts,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  };
}
