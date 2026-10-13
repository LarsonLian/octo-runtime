import { assertContextEnvelope, assertJsonValue, contextItem } from "./context.js";
import type {
  ContextEnvelope,
  ScenarioRequest,
  ScenarioPolicy,
  ScenarioPolicySnapshot
} from "./generated/protocol-types.js";
export const SCENARIO_ID = "doc.selection.review";
export const SCENARIO_LOOP_DISCUSSION = "loop_discussion";
export const SCENARIO_LOOP_TASK = "loop_task";
const scenarioBuilders: Record<string, string> = {
  [SCENARIO_ID]: "doc-selection",
  [SCENARIO_LOOP_DISCUSSION]: "loop-discussion",
  [SCENARIO_LOOP_TASK]: "loop-task"
};
const encoder = new TextEncoder();
function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.hasOwn(v, "default_skills"))
    throw new TypeError("SCENARIO_INVALID");
}
export function assertScenarioRequest(
  v: unknown,
  context?: ContextEnvelope
): asserts v is ScenarioRequest {
  object(v);
  if (
    typeof v.scenario_id !== "string" ||
    !Object.hasOwn(scenarioBuilders, v.scenario_id) ||
    v.builder_id !== scenarioBuilders[v.scenario_id] ||
    v.builder_version !== "1"
  )
    throw new TypeError("SCENARIO_UNSUPPORTED");
  if (context) {
    assertContextEnvelope(context);
    // Loop 正文来自业务层授权对象，无文档选区约束；Context v3 仍完整校验。
    if (v.scenario_id !== SCENARIO_ID) return;
    const entries = contextItem(context, "octo.content", "inline")?.payload.entries as
      Record<string, unknown>[] | undefined;
    const e = entries?.[0];
    const source = e?.source as Record<string, unknown> | undefined;
    if (
      entries?.length !== 1 ||
      typeof e?.text !== "string" ||
      !e.text ||
      encoder.encode(e.text).length > 32768 ||
      source?.kind !== "document_selection" ||
      typeof source.document_id !== "string" ||
      !source.document_id
    )
      throw new TypeError("SCENARIO_INVALID");
  }
}
export function assertScenarioPolicy(v: unknown): asserts v is ScenarioPolicy {
  object(v);
  assertJsonValue(v);
  if (
    typeof v.enabled !== "boolean" ||
    !Array.isArray(v.instructions) ||
    v.instructions.length > 32 ||
    v.instructions.some((x) => typeof x !== "string" || !x) ||
    encoder.encode(v.instructions.join("")).length > 16384 ||
    encoder.encode(JSON.stringify(v)).length > 65536
  )
    throw new TypeError("SCENARIO_INVALID");
}
export function canonicalScenarioPolicy(
  v: Pick<ScenarioPolicySnapshot, "scenario_id" | "version" | "instructions">
): string {
  if (
    !Object.hasOwn(scenarioBuilders, v.scenario_id) ||
    !Number.isSafeInteger(v.version) ||
    v.version < 1
  )
    throw new TypeError("SCENARIO_INVALID");
  assertScenarioPolicy({ enabled: true, instructions: v.instructions });
  // Same recursively sorted JSON object keys as Go CanonicalScalarJSON.
  return JSON.stringify({
    instructions: v.instructions,
    scenario_id: v.scenario_id,
    version: v.version
  });
}
export function assertScenarioSnapshot(v: unknown): asserts v is ScenarioPolicySnapshot {
  object(v);
  canonicalScenarioPolicy(v as unknown as ScenarioPolicySnapshot);
  if (typeof v.hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(v.hash))
    throw new TypeError("SCENARIO_POLICY_MISMATCH");
}
