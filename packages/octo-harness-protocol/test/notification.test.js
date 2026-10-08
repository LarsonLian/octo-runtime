import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNotificationMessage } from "../dist/index.js";

const message = { schema: "octo.notification.v1", eventId: "run-1/completed", event: "execution.succeeded", occurredAt: "2026-10-08T08:00:00Z", projectId: "project-1", sourceId: "run-1", title: "Review complete", text: "Public result" };

test("notification accepts public events and empty results", () => {
  assertNotificationMessage(message);
  assertNotificationMessage({ ...message, event: "notification.test", text: "" });
});

test("notification rejects private payloads, unknown events and malformed content", () => {
  for (const value of [
    { ...message, context: { token: "private" } },
    { ...message, event: "run.completed" },
    { ...message, occurredAt: "yesterday" },
    { ...message, text: "x".repeat(4097) },
    { ...message, text: "\ud800" },
    { ...message, title: "" },
  ]) assert.throws(() => assertNotificationMessage(value));
});
