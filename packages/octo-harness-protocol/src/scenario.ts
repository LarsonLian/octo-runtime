import { assertContextEnvelope } from "./context.js";
import type {
  ContextEnvelope,
  ScenarioRequest
} from "./generated/protocol-types.js";
export const SCENARIO_ID = "doc.selection.review";
export const SCENARIO_LOOP_DISCUSSION = "loop_discussion";
export const SCENARIO_LOOP_TASK = "loop_task";
const scenarioBuilders: Record<string, string> = {
  [SCENARIO_ID]: "doc-selection",
  [SCENARIO_LOOP_DISCUSSION]: "loop-discussion",
  [SCENARIO_LOOP_TASK]: "loop-task"
};
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
  if (context) assertContextEnvelope(context);
}
