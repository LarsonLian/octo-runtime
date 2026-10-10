import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { CodexEventNormalizer } from "../packages/octo-harness-adapter-codex/dist/app-server.js";

test("host emits activity without persisting private analysis and closes every activity", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { type: "experience", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke() {
    yield { protocolVersion: 2, type: "message.delta", payload: { channel: "analysis", exposure: "private_reasoning", provenance: { provider: "experience", nativeEvent: "reasoning" }, text: "secret-body" } };
    yield { protocolVersion: 2, type: "message.delta", payload: { channel: "commentary", text: "Looking at source" } };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  } });
  const events = [];
  for await (const event of host.invoke("experience", { protocolVersion: 2, invocationId: "i", agentSessionKey: "s", runKey: "r", prompt: "p", modelInput: "p", workdir: process.cwd(), context: { schema: "octo.context-envelope/v3", items: [] }, controlInstructions: "", approvalMode: "full_access", agentSource: "provisioned", agentConfig: {} })) events.push(event);
  assert.equal(events[0].payload.kind, "starting");
  assert.doesNotMatch(JSON.stringify(events), /secret-body/);
  assert.ok(events.some(event => event.type === "activity.started" && event.payload.kind === "thinking"));
  const starts = events.filter(event => event.type === "activity.started").map(event => event.payload.activityId).sort();
  const ends = events.filter(event => event.type === "activity.finished").map(event => event.payload.activityId).sort();
  assert.deepEqual(starts, ends);
  assert.deepEqual(events.at(-1).payload, {});
});

test("Codex maps plan revisions, MCP progress and safe retry notices", () => {
  const normalizer = new CodexEventNormalizer();
  const plan = { method: "turn/plan/updated", params: { plan: [{ step: "Inspect", status: "inProgress" }] } };
  assert.equal(normalizer.normalize(plan)[0].payload.revision, 1);
  assert.equal(normalizer.normalize(plan)[0].payload.revision, 2);
  assert.equal(normalizer.normalize(plan)[0].payload.steps[0].status, "in_progress");
  assert.deepEqual(normalizer.normalize({ method: "item/mcpToolCall/progress", params: { itemId: "tool-1", message: "Fetching" } })[0].payload, { id: "tool-1", progress: { message: "Fetching" } });
  const retry = normalizer.normalize({ method: "error", params: { willRetry: true, message: "Bearer secret" } });
  assert.equal(retry[0].payload.code, "retry_scheduled");
  assert.equal(retry[0].payload.params.attempt, 2);
  assert.doesNotMatch(JSON.stringify(retry), /secret/);
});
