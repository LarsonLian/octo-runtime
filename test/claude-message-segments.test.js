import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeEventNormalizer } from "@mininglamp-oss/octo-harness-adapter-claude-code";

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
