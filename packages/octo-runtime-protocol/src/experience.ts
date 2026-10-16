type Payload = Record<string, unknown>;
export const PROVIDER_DIAGNOSTIC_MAX_BYTES = 2048;
const kinds = new Set([
  "starting",
  "thinking",
  "executing_tool",
  "responding",
  "waiting_approval",
  "waiting_input",
  "compacting",
  "retrying",
  "working"
]);
const terminal = new Set(["completed", "failed", "cancelled"]);

function record(value: unknown): value is Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > 191)
    throw new TypeError("experience identifier must contain 1..191 characters");
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum)
    throw new TypeError("experience count must be a safe non-negative integer");
}

function fields(payload: Payload, allowed: string[], required: string[]): void {
  if (
    Object.keys(payload).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in payload))
  )
    throw new TypeError("experience payload contains unknown or missing fields");
}

function info(value: unknown): void {
  if (!record(value)) throw new TypeError("activity info must be an object");
  fields(value, ["messageKey", "params", "attempt", "retryAfterMs"], []);
  if (value.messageKey !== undefined) string(value.messageKey);
  if (
    value.params !== undefined &&
    (!record(value.params) ||
      Object.values(value.params).some(
        (item) => !["string", "number", "boolean"].includes(typeof item)
      ))
  )
    throw new TypeError("activity params must contain scalar values");
  if (value.attempt !== undefined) integer(value.attempt, 1);
  if (value.retryAfterMs !== undefined) integer(value.retryAfterMs);
}

export function assertExperiencePayload(type: string, payload: Payload): void {
  switch (type) {
    case "activity.started": {
      fields(
        payload,
        ["activityId", "kind", "subject", "source", "info", "startedAtMs"],
        ["activityId", "kind", "subject", "source", "info"]
      );
      string(payload.activityId);
      if (
        !kinds.has(String(payload.kind)) ||
        !["provider", "harness"].includes(String(payload.source))
      )
        throw new TypeError("invalid activity kind or source");
      if (
        !record(payload.subject) ||
        !["run", "message", "tool", "interaction"].includes(String(payload.subject.type))
      )
        throw new TypeError("invalid activity subject");
      fields(
        payload.subject,
        ["type", "id"],
        payload.subject.type === "run" ? ["type"] : ["type", "id"]
      );
      if (payload.subject.type === "run" && payload.subject.id !== undefined)
        throw new TypeError("run subject cannot contain id");
      if (payload.subject.type !== "run") string(payload.subject.id);
      info(payload.info);
      if (payload.startedAtMs !== undefined) integer(payload.startedAtMs);
      break;
    }
    case "activity.updated":
      fields(payload, ["activityId", "info"], ["activityId", "info"]);
      string(payload.activityId);
      info(payload.info);
      break;
    case "activity.finished":
      fields(payload, ["activityId", "status", "endedAtMs"], ["activityId", "status"]);
      string(payload.activityId);
      if (!terminal.has(String(payload.status)) && payload.status !== "superseded")
        throw new TypeError("invalid activity terminal");
      if (payload.endedAtMs !== undefined) integer(payload.endedAtMs);
      break;
    case "plan.updated":
      fields(
        payload,
        ["planId", "revision", "explanation", "steps"],
        ["planId", "revision", "explanation", "steps"]
      );
      string(payload.planId);
      integer(payload.revision, 1);
      if (
        payload.explanation !== null &&
        (typeof payload.explanation !== "string" || payload.explanation.length > 4096)
      )
        throw new TypeError("invalid plan explanation");
      if (!Array.isArray(payload.steps) || payload.steps.length > 200)
        throw new TypeError("invalid plan steps");
      for (const step of payload.steps) {
        if (!record(step)) throw new TypeError("invalid plan step");
        fields(step, ["text", "status"], ["text", "status"]);
        if (
          typeof step.text !== "string" ||
          !step.text ||
          step.text.length > 4096 ||
          !["pending", "in_progress", "completed", "blocked", "cancelled"].includes(
            String(step.status)
          )
        )
          throw new TypeError("invalid plan step");
      }
      break;
    case "tool_call.progress": {
      fields(payload, ["id", "progress"], ["id", "progress"]);
      string(payload.id);
      if (!record(payload.progress)) throw new TypeError("invalid tool progress");
      const progress = payload.progress;
      fields(progress, ["message", "completed", "total", "unit"], []);
      if (
        progress.message !== undefined &&
        (typeof progress.message !== "string" || progress.message.length > 4096)
      )
        throw new TypeError("invalid progress message");
      if (["completed", "total", "unit"].some((key) => key in progress)) {
        integer(progress.completed);
        integer(progress.total, 1);
        if (
          progress.completed > progress.total ||
          !["items", "bytes", "steps"].includes(String(progress.unit))
        )
          throw new TypeError("invalid progress quantity");
      }
      break;
    }
    case "run.notice": {
      fields(
        payload,
        ["noticeId", "code", "severity", "params", "relatedActivityId", "relatedItemId"],
        ["noticeId", "code", "severity", "params"]
      );
      string(payload.noticeId);
      if (!["info", "warning"].includes(String(payload.severity)) || !record(payload.params))
        throw new TypeError("invalid notice");
      const params = payload.params;
      switch (payload.code) {
        case "context_compacted":
          fields(params, [], []);
          break;
        case "retry_scheduled":
          fields(params, ["attempt", "retryAfterMs"], ["attempt"]);
          integer(params.attempt, 1);
          if (params.retryAfterMs !== undefined) integer(params.retryAfterMs);
          break;
        case "model_rerouted":
          fields(params, ["fromModel", "toModel", "reasonCode"], ["fromModel", "toModel"]);
          string(params.fromModel);
          string(params.toModel);
          if (params.reasonCode !== undefined) string(params.reasonCode);
          break;
        case "config_warning":
          fields(params, ["warningCode"], ["warningCode"]);
          string(params.warningCode);
          break;
        case "provider_diagnostic":
          fields(
            params,
            ["adapter", "diagnosticId", "category", "message"],
            ["adapter", "diagnosticId", "category", "message"]
          );
          string(params.adapter);
          string(params.diagnosticId);
          string(params.category);
          if (
            payload.severity !== "warning" ||
            typeof params.message !== "string" ||
            !params.message.trim() ||
            new TextEncoder().encode(params.message).byteLength > PROVIDER_DIAGNOSTIC_MAX_BYTES
          )
            throw new TypeError("invalid provider diagnostic");
          break;
        default:
          throw new TypeError("invalid notice code");
      }
      if (payload.relatedActivityId !== undefined) string(payload.relatedActivityId);
      if (payload.relatedItemId !== undefined) string(payload.relatedItemId);
      break;
    }
  }
}
