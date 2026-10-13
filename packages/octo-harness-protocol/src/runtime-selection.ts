import { assertJsonValue } from "./context.js";
import type { ResolvedRuntimeSelection } from "./generated/protocol-types.js";

export const RUNTIME_SELECTION_SCHEMA = "octo.runtime-selection/v2" as const;

export function assertResolvedRuntimeSelection(
  value: unknown
): asserts value is ResolvedRuntimeSelection {
  object(value, "RESOLVED_RUNTIME_SELECTION_REQUIRED");
  assertJsonValue(value);
  fields(value, [
    "schema",
    "context_configuration_version",
    "selection_mode",
    "explicit_runtime_id",
    "authorized_candidates",
    "offline_behavior",
    "failover"
  ]);
  if (
    value.schema !== RUNTIME_SELECTION_SCHEMA ||
    !["explicit", "candidates"].includes(value.selection_mode as string) ||
    !["wait", "fail"].includes(value.offline_behavior as string) ||
    !["candidates", "none"].includes(value.failover as string)
  )
    invalid();
  positiveInteger(value.context_configuration_version);
  if (value.selection_mode === "explicit") text(value.explicit_runtime_id);
  else if (Object.hasOwn(value, "explicit_runtime_id")) invalid();
  if (value.selection_mode === "explicit" && value.failover !== "none") invalid();
  if (
    !Array.isArray(value.authorized_candidates) ||
    value.authorized_candidates.length === 0 ||
    value.authorized_candidates.length > 64
  )
    invalid();
  const runtimeIds = new Set<string>();
  const priorities = new Set<number>();
  for (const candidate of value.authorized_candidates) {
    object(candidate);
    fields(candidate, ["runtime_id", "priority", "owner_subject_type", "owner_subject_id"]);
    text(candidate.runtime_id);
    text(candidate.owner_subject_type);
    if (candidate.owner_subject_type !== "user" && candidate.owner_subject_type !== "teamspace")
      invalid();
    text(candidate.owner_subject_id);
    positiveInteger(candidate.priority);
    if (runtimeIds.has(candidate.runtime_id) || priorities.has(candidate.priority as number))
      invalid();
    runtimeIds.add(candidate.runtime_id);
    priorities.add(candidate.priority as number);
  }
  if (
    value.selection_mode === "explicit" &&
    (value.authorized_candidates.length !== 1 ||
      !runtimeIds.has(value.explicit_runtime_id as string))
  )
    invalid();
}

function invalid(): never {
  throw new TypeError("RESOLVED_RUNTIME_SELECTION_INVALID");
}

function object(
  value: unknown,
  code = "RESOLVED_RUNTIME_SELECTION_INVALID"
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(code);
}

function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}

function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || [...value].length > 191) invalid();
}

function positiveInteger(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
}
