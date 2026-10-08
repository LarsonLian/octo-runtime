import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNotificationMessage } from "../dist/index.js";

const message = { schema: "octo.notification.v2", eventId: "run-1/completed", event: "execution.succeeded", occurredAt: "2026-10-08T08:00:00Z", projectId: "project-1", sourceId: "run-1", title: "Review complete", text: "Public result" };

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

test("task notifications carry bounded ordered business history", () => {
  const task = { ...message, event: "task.event", eventId: "evt-2", sourceId: "task-1", evt_type: 112,
    task: { id: "task-1", title: "Review", status: "in_progress", row_version: 2, handler_epoch: 1 },
    taskEvent: { id: "evt-2", sequence: 2, evt_type: 112, actor: { type: "agent", id: "reviewer" }, summary: "Report submitted", payload: { attachment_ids: ["a", "b"] } },
    timeline: [{ eventId: "evt-1", sequence: 1, evt_type: 113, summary: "Started" }, { eventId: "evt-2", sequence: 2, evt_type: 112, summary: "Report submitted" }], timelineThroughSequence: 2 };
  assertNotificationMessage(task);
  for (const value of [{ ...task, evt_type: "112" }, { ...task, timelineThroughSequence: 3 }, { ...task, timeline: task.timeline.toReversed() }, { ...task, task: { ...task.task, id: "other" } }, { ...message, evt_type: 112 }, { ...task, taskEvent: { ...task.taskEvent, token: "secret" } }]) assert.throws(() => assertNotificationMessage(value));
});
