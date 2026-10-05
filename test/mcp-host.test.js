import assert from "node:assert/strict";
import test from "node:test";

import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { capabilities } from "@mininglamp-oss/octo-harness-protocol";

const request = { protocolVersion: 2,
  invocationId: "invoke-mcp",
  agentSessionId: "session-mcp",
  runId: "run-mcp",
  prompt: "call the tool",
  workdir: process.cwd(),
  appendInstructions: "",
  context: {},
  agentConfig: {},
  mcpServers: {
    team: {
      type: "streamable_http",
      url: "https://worker.example.test/mcp/team",
      headers: { Authorization: "Bearer must-not-appear-in-errors" }
    }
  }
};

async function collect(iterable) {
  const result = [];
  for await (const item of iterable) result.push(item);
  return result;
}

test("Adapter Host rejects dynamic MCP before invoking an unsupported adapter", async () => {
  let invoked = false;
  const host = new AdapterHost();
  host.register({
    metadata: { type: "unsupported", capabilities: [] },
    async *invoke() {
      invoked = true;
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });

  await assert.rejects(
    collect(host.invoke("unsupported", request)),
    error => {
      assert.match(error.message, /does not support dynamic MCP/);
      assert.doesNotMatch(error.message, /must-not-appear-in-errors/);
      return true;
    }
  );
  assert.equal(invoked, false);
});

test("Adapter Host passes a dynamic MCP plan to an adapter that declares support", async () => {
  let received;
  const host = new AdapterHost();
  host.register({
    metadata: { type: "supported", capabilities: [capabilities.MCP_DYNAMIC] },
    async *invoke(value) {
      received = value.mcpServers;
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });

  const events = await collect(host.invoke("supported", request));
  assert.deepEqual(received, request.mcpServers);
  assert.equal(events.at(-1).type, "run.completed");
});
