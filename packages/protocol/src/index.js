import { randomUUID } from "node:crypto";

export const TERMINAL_EVENTS = new Set(["run.finished", "run.error", "run.stopped"]);

export const EVENT_TYPES = new Set([
  "session.update", "usage.update",
  "message.create", "message.delta", "message.update",
  "tool_call.create", "tool_call.delta", "tool_call.update",
  "surface.create", "surface.delta", "surface.update",
  "run.queued", "run.running",
  ...TERMINAL_EVENTS
]);

export const capabilities = Object.freeze({
  SESSION_SERIALIZE: "session.serialize",
  SESSION_FORK: "session.fork",
  MESSAGE_APPEND: "message.append",
  TOOL_CANONICAL: "tool.canonical",
  REATTACH: "run.reattach"
});

export function envelope(run, seq, event) {
  assertCanonicalEvent(event);
  return Object.freeze({
    id: randomUUID(),
    seq,
    tsMs: Date.now(),
    sessionId: run.sessionId,
    runId: run.id,
    type: event.type,
    payload: event.payload ?? {}
  });
}

export function assertCanonicalEvent(event) {
  if (!event || !EVENT_TYPES.has(event.type)) throw new TypeError(`unsupported canonical event: ${event?.type}`);
  if (event.payload !== undefined && (event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload))) {
    throw new TypeError("event.payload must be an object");
  }
}

export function assertInvokeRequest(req) {
  for (const key of ["invocationId", "sessionId", "runId", "prompt", "workdir"]) {
    if (typeof req?.[key] !== "string" || req[key].length === 0) {
      throw new TypeError(`InvokeRequest.${key} must be a non-empty string`);
    }
  }
}

export function isTerminal(event) {
  return TERMINAL_EVENTS.has(event.type);
}
