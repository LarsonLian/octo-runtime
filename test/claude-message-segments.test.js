import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeEventNormalizer } from "@mininglamp-oss/octo-runtime-adapter-claude-code";

test("Claude preserves message/block identity and closes each streamed text segment", () => {
  const n = new ClaudeEventNormalizer();
  const emit = event => n.normalize({ type: "stream_event", event });
  const ids = [];
  for (const id of ["before-tool", "after-tool"]) {
    emit({ type: "message_start", message: { id } });
    for (const index of [0, 1]) {
      const start = emit({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      const delta = emit({ type: "content_block_delta", index, delta: { type: "text_delta", text: "public" } });
      const end = emit({ type: "content_block_stop", index });
      assert.equal(start[0].payload.messageId, delta[0].payload.messageId);
      assert.equal(end[0].payload.messageId, delta[0].payload.messageId);
      assert.equal(end[0].payload.status, "completed");
      ids.push(delta[0].payload.messageId);
    }
    emit({ type: "message_stop" });
  }
  assert.equal(new Set(ids).size, 4);
});

test("Claude complete-message snapshots are identified and replayed only once", () => {
  const n = new ClaudeEventNormalizer();
  const native = { type: "assistant", message: { id: "m", content: [{ type: "text", text: "answer" }] } };
  const events = n.normalize(native);
  assert.equal(events[0].type, "message.update");
  assert.equal(events[0].payload.status, "completed");
  assert.ok(events[0].payload.messageId);
  assert.deepEqual(n.normalize(native), []);
});

test("Claude reports native compaction after session initialization without creating a new turn", () => {
  const n = new ClaudeEventNormalizer();
  n.normalize({ type: "system", subtype: "init", session_id: "session" });
  const events = n.normalize({ type: "system", subtype: "compact_boundary", session_id: "session" });
  assert.deepEqual(events.map(event => event.type), ["run.notice", "session.update"]);
  assert.equal(events[0].payload.code, "context_compacted");
  assert.deepEqual(events[1].payload.providerSession, { sessionId: "session", resumable: true, resumeOutcome: "compacted" });
  const next = n.normalize({ type: "system", subtype: "compact_boundary", session_id: "session" });
  assert.notEqual(next[0].payload.noticeId, events[0].payload.noticeId);
});
