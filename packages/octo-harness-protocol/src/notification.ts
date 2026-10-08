import { assertJsonValue } from "./context.js";
import type { NotificationMessage } from "./generated/protocol-types.js";

const keys = ["schema", "eventId", "event", "occurredAt", "projectId", "sourceId", "title", "text"] as const;
const events = new Set(["task.done", "execution.succeeded", "execution.failed", "notification.test"]);

export function assertNotificationMessage(value: unknown): asserts value is NotificationMessage {
  assertJsonValue(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("notification must be an object");
  const message = value as Record<string, unknown>;
  if (Object.keys(message).length !== keys.length || keys.some(key => typeof message[key] !== "string")) {
    throw new Error("notification contains missing or unsupported fields");
  }
  if (message.schema !== "octo.notification.v1" || !events.has(message.event as string)) throw new Error("unsupported notification schema or event");
  for (const [key, max, min] of [["eventId", 256, 1], ["projectId", 128, 1], ["sourceId", 128, 1], ["title", 256, 1], ["text", 4096, 0]] as const) {
    const length = Array.from(message[key] as string).length;
    if (length < min || length > max) throw new Error(`invalid notification ${key}`);
  }
  const timestamp = message.occurredAt as string;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error("invalid notification occurredAt");
  }
}
