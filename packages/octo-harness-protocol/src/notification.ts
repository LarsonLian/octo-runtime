import type { NotificationMessage } from "./generated/protocol-types.js";

const keys = [
  "schema",
  "eventId",
  "event",
  "occurredAt",
  "projectId",
  "sourceId",
  "title",
  "text"
] as const;
const events = new Set([
  "task.event",
  "execution.succeeded",
  "execution.failed",
  "notification.test"
]);
const taskIds = [
  "evt_type",
  "task",
  "taskEvent",
  "timeline",
  "timelineTruncated",
  "timelineThroughSequence"
];

export function assertNotificationMessage(value: unknown): asserts value is NotificationMessage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("notification must be an object");
  const message = value as Record<string, unknown>;
  if (
    Object.keys(message).some(
      (key) => !keys.includes(key as (typeof keys)[number]) && !taskIds.includes(key)
    ) ||
    keys.some((key) => typeof message[key] !== "string")
  ) {
    throw new Error("notification contains missing or unsupported fields");
  }
  for (const key of keys) {
    for (const scalar of message[key] as string) {
      const code = scalar.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff)
        throw new Error("notification contains an unpaired surrogate");
    }
  }
  if (message.schema !== "octo.notification.v2" || !events.has(message.event as string))
    throw new Error("unsupported notification schema or event");
  if (message.event === "task.event") {
    validateTaskNotification(message);
  } else if (taskIds.some((key) => key in message)) {
    throw new Error("task fields require a task event");
  }
  for (const [key, max, min] of [
    ["eventId", 256, 1],
    ["projectId", 128, 1],
    ["sourceId", 128, 1],
    ["title", 256, 1],
    ["text", 4096, 0]
  ] as const) {
    const length = Array.from(message[key] as string).length;
    if (length < min || length > max) throw new Error(`invalid notification ${key}`);
  }
  const timestamp = message.occurredAt as string;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    throw new Error("invalid notification occurredAt");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid task notification object");
  return value as Record<string, unknown>;
}

function knownFields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = []
): void {
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error("invalid task notification fields");
}

function eventType(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 101 && Number(value) <= 115;
}
function sequence(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function validateTaskNotification(message: Record<string, unknown>): void {
  const task = object(message.task),
    event = object(message.taskEvent);
  knownFields(
    task,
    ["id", "title", "status", "row_version", "handler_epoch"],
    ["responsible_party", "current_handler"]
  );
  knownFields(
    event,
    ["id", "sequence", "evt_type", "actor", "summary", "payload"],
    ["task_conversation_id", "source_run_id"]
  );
  if (
    task.id !== message.sourceId ||
    typeof task.title !== "string" ||
    !["backlog", "todo", "in_progress", "done", "cancelled"].includes(String(task.status)) ||
    !sequence(task.row_version) ||
    !sequence(task.handler_epoch)
  )
    throw new Error("invalid task snapshot");
  const actor = object(event.actor);
  if (
    typeof actor.type !== "string" ||
    typeof actor.id !== "string" ||
    typeof event.summary !== "string"
  )
    throw new Error("invalid event actor or summary");
  object(event.payload);
  if (
    !eventType(message.evt_type) ||
    message.evt_type !== event.evt_type ||
    event.id !== message.eventId ||
    !sequence(event.sequence) ||
    message.timelineThroughSequence !== event.sequence
  )
    throw new Error("invalid task event identity");
  if (message.timelineTruncated !== undefined && typeof message.timelineTruncated !== "boolean")
    throw new Error("invalid timeline truncation");
  if (!Array.isArray(message.timeline) || message.timeline.length > 20)
    throw new Error("invalid task timeline");
  let previous = 0;
  for (const value of message.timeline) {
    const item = object(value);
    knownFields(item, ["eventId", "sequence", "evt_type", "summary"]);
    if (
      typeof item.eventId !== "string" ||
      typeof item.summary !== "string" ||
      !eventType(item.evt_type) ||
      !sequence(item.sequence) ||
      Number(item.sequence) <= previous ||
      Number(item.sequence) > Number(event.sequence)
    )
      throw new Error("invalid task timeline order");
    previous = Number(item.sequence);
  }
  checkScalars(message);
}

function checkScalars(value: unknown): void {
  if (typeof value === "string") {
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (code >= 0xd800 && code <= 0xdfff)
        throw new Error("notification contains an unpaired surrogate");
    }
  } else if (Array.isArray(value)) value.forEach(checkScalars);
  else if (value && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      checkScalars(key);
      checkScalars(item);
    }
}
