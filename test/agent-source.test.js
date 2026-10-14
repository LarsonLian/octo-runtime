import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { assertInvokeRequest, assertResolvedExecutionPlan } from "@mininglamp-oss/octo-runtime-protocol";
import { prepareRunContext } from "@mininglamp-oss/octo-runtime-adapter-host";
import { AgentWorkStore } from "../packages/octo-runtime-worker-access/dist/agent-work-store.js";

const request = {
  protocolVersion: 2, invocationId: "source-invocation", runId: "source-run", agentSessionId: "source-session",
  agentSource: "preset", workdir: "", prompt: "work", modelInput: "work", controlInstructions: "",
  approvalMode: "full_access", context: { schema: "octo.context-envelope/v3", items: [] }, agentConfig: { providerAgentId: "main" }
};

test("source is required and empty workdir is exclusive to preset invocation", () => {
  assertInvokeRequest(request);
  for (const agentSource of [undefined, "external", "provisioned"]) {
    assert.throws(() => assertInvokeRequest({ ...request, agentSource }));
  }
  const plan = { agent_source: "preset", adapter_type: "openclaw", provider_agent_id: "main", workdir: "", workspace: { mode: "none" }, approval_mode: "full_access" };
  assertResolvedExecutionPlan(plan);
  assert.throws(() => assertResolvedExecutionPlan({ ...plan, provider_agent_id: undefined }));
  assert.throws(() => assertResolvedExecutionPlan({ ...plan, agent_source: "provisioned" }));
  assert.throws(() => assertResolvedExecutionPlan({ ...plan, required_capabilities: ["session.serialize"] }));
});

test("public react does not bypass adapter source admission", async () => {
  let invocations = 0;
  const host = new AdapterHost();
  host.register({
    metadata: { protocolSupport: { protocol: ("fixture") + '.canonical', modes: ['canonical'], nativeMethods: [] }, type: "fixture", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] },
    async *invoke() { invocations++; yield { protocolVersion: 2, type: "run.completed", payload: {} }; }
  });
  await assert.rejects(async () => { for await (const event of host.invoke("fixture", request, { protocolMode: "canonical" })) assert.fail(event.type); }, /AGENT_SOURCE_UNSUPPORTED/);
  assert.equal(invocations, 0);
  assert.deepEqual(host.list()[0].capabilities, ["react"]);
});

test("preset preparation creates no workspace or provider directory and rejects filesystem resources", async t => {
  const root = await mkdtemp(join(tmpdir(), "octo-source-"));
  const store = new AgentWorkStore();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const plan = { agent_source: "preset", adapter_type: "openclaw", provider_agent_id: "main", workdir: "", workspace: { mode: "none" }, approval_mode: "full_access" };
  const options = { stateRoot: join(root, "state"), agentSessionId: "session", agentId: "agent", store };
  const prepared = await prepareRunContext(plan, options);
  assert.equal(prepared.workdir, "");
  assert.equal(prepared.providerStateDir, "");
  assert.deepEqual(prepared.receipt, { workspace_mode: "none", workspace_path: "", provider_state_dir: "", warnings: [] });
  assert.deepEqual(await readdir(options.stateRoot), []);
  await assert.rejects(prepareRunContext({ ...plan, resources: [{}] }, options), /CONTEXT_SCHEMA_INVALID|CONTEXT_WORKSPACE_INVALID/);
});
