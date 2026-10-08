import assert from "node:assert/strict";
import test from "node:test";
import { prepareTeamInput } from "../packages/octo-harness-daemon/dist/team-input.js";
import { mapExecutionEnvelope } from "../packages/octo-harness-daemon/dist/agent-work-runtime.js";
import { buildCodexCommand } from "@mininglamp-oss/octo-harness-adapter-codex";
import { contextEnvelope, executionContext, resolvedRuntimeSelection } from "./agent-work-runtime-fixture.js";

const ref = { resource_ref: "task:task-1/materials", task_id: "task-1", task_version: 18, handler_epoch: 3, digest: `sha256:${"a".repeat(64)}` };
const materials = { refs: [ref], selections: [{ resource_ref: ref.resource_ref, text: JSON.stringify({
  task: { id: "task-1", row_version: 18, handler_epoch: 3 }, attachments: [{ id: "att-1", version_id: "fv-1" }]
}) }] };
const input = { task_execution: { task_id: "task-1", handler_type: "team", workspace_bindings: {} },
  coordination: { team_session_id: "team-session-1", delegation_id: "delegation-1", source_run_id: "source-1", target_alias: "designer" }, payload: {
  schema_version: 1, instruction: "使用需求附件制作活动页面", task_material_ref: { task_id: "task-1", snapshot_version: 17 },
  attachment_refs: [{ attachment_id: "att-1", file_version_id: "fv-1" }], reply_to: { kind: "delegation_result" },
  result_contract: { summary_required: true, output_manifest_required: true }
} };

test("task Team handoff uses fresh authorized materials and stable attachment versions", () => {
  const result = prepareTeamInput(input, "coordination.delegate_handoff", materials);
  assert.equal(result.displayText, input.payload.instruction);
  assert.match(result.modelContent, /fv-1/);
  assert.match(result.modelContent, /Untrusted Team handoff/);
  assert.throws(() => prepareTeamInput(input, "coordination.delegate_handoff"), /TEAM_TASK_SCOPE_MISMATCH/);
  assert.equal(prepareTeamInput(input, "user.message"), undefined);
  const mismatch = structuredClone(input);
  mismatch.payload.task_material_ref.task_id = "unrelated-task";
  assert.throws(() => prepareTeamInput(mismatch, "coordination.delegate_handoff", materials), /TEAM_TASK_SCOPE_MISMATCH/);
  mismatch.payload.task_material_ref.task_id = "task-1";
  mismatch.payload.task_material_ref.snapshot_version = 19;
  assert.throws(() => prepareTeamInput(mismatch, "coordination.delegate_handoff", materials), /TEAM_TASK_SCOPE_MISMATCH/);
});

test("task handoff rejects local paths, credentials and unavailable attachment versions", () => {
  for (const override of [{ path: "/Users/source/project/output.html" }, { download_url: "file:///output" }, { authorization: "source-run-grant" }]) {
    const changed = structuredClone(input);
    Object.assign(changed.payload.attachment_refs[0], override);
    assert.throws(() => prepareTeamInput(changed, "coordination.delegate_handoff", materials), /TEAM_TASK_INPUT_INVALID/);
  }
  const changed = structuredClone(input);
  changed.payload.attachment_refs[0].file_version_id = "not-readable-version";
  assert.throws(() => prepareTeamInput(changed, "coordination.delegate_handoff", materials), /TEAM_TASK_ATTACHMENT_UNAVAILABLE/);
});

test("actual Worker wrapper renders handoff instruction and mailbox output references without a parallel engine", () => {
  const plan = { adapter_type: "codex", workdir: "/target-runtime/workspace", approval_mode: "full_access", mcp_servers: {
    octo_task: { type: "streamable_http", url: "https://worker.test/mcp/team", headers: { Authorization: "Bearer target-only-grant" }, required: true }
  } };
  plan.mcp_servers.octo_team = structuredClone(plan.mcp_servers.octo_task);
  const resource = { namespace: "octo.content", name: "resources", payload: { entries: [{ resource_ref: ref.resource_ref,
    resolver: "mcp", locator: { server_ref: "octo_task", tool: "task_get_materials" }, params: { task_id: "task-1", handler_epoch: 3 }
  }] } };
  const envelope = { schema_version: 4, effective_context: executionContext(plan, [resource]), context_configuration_version: 1,
    resolved_execution_plan: plan, resolved_runtime_selection: resolvedRuntimeSelection(), run_id: "target-run", agent_session_id: "target-session",
    agent_run_request: { context: contextEnvelope([resource]), namespace: "task", agent_id: "designer", agent_revision_id: "designer-rev", session_key: "team/designer",
      trigger: { kind: "coordination.delegate_handoff", occurrence_id: "delegation/1" }, input }, agent_revision: { definition: { instructions: "Keep project rules" } } };
  const { request } = mapExecutionEnvelope(envelope, undefined, materials);
  assert.equal(request.prompt, `[Current message]\n${input.payload.instruction}`);
  assert.match(request.modelInput, /attachment_refs/);
  assert.doesNotMatch(request.modelInput, /target-only-grant/);
  assert.doesNotMatch(request.controlInstructions, /使用需求附件/);
  assert.equal(request.workdir, "/target-runtime/workspace");
  assert.match(JSON.stringify(buildCodexCommand(request).args), /octo_team.*delegate_handoff.*approval_mode/);
  const mailbox = { task_execution: input.task_execution, coordination: input.coordination, message: { child_run_id: "target-run", status: "completed",
    messages: [{ item_id: "item-1", text: "页面已生成" }], task_output_receipts: [{ output_id: "page-1", status: "saved", attachment_id: "att-page", file_id: "file-page", file_version_id: "fv-page" }]
  } };
  envelope.agent_run_request.input = mailbox;
  envelope.agent_run_request.trigger.kind = "coordination.mailbox";
  const wake = mapExecutionEnvelope(envelope, undefined, materials).request;
  assert.match(wake.modelInput, /fv-page/);
  assert.match(wake.modelInput, /页面已生成/);
  assert.doesNotMatch(wake.modelInput, /target-only-grant/);
  assert.match(JSON.stringify(buildCodexCommand(wake).args), /octo_team.*delegate_handoff.*approval_mode/);
});

test("non-task existing Team payload is retained as bounded facts instead of an empty prompt", () => {
  const legacy = { coordination: input.coordination, payload: { operation: "check", design: { columns: 3 }, prompt: "Check the design" } };
  const result = prepareTeamInput(legacy, "coordination.delegate_handoff");
  assert.equal(result.displayText, "Check the design");
  assert.match(result.modelContent, /columns/);
  legacy.payload.extra = "a".repeat(70_000);
  assert.throws(() => prepareTeamInput(legacy, "coordination.delegate_handoff"), /TEAM_INPUT_BUDGET_EXCEEDED/);
});
