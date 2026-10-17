import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeEventNormalizer } from "@mininglamp-oss/octo-runtime-adapter-opencode";

test("OpenCode retains part IDs, replaces snapshots and does not replay tool starts", () => {
  const n = new OpenCodeEventNormalizer();
  const text = (id, text) =>
    n.normalize({ type: "text", part: { type: "text", id, messageID: "round", text } });
  const first = text("part1", "hello")[0];
  assert.deepEqual(text("part1", "hello"), []);
  assert.equal(text("part1", "hello world")[0].payload.text, " world");
  const replacement = text("part1", "replacement")[0];
  assert.equal(replacement.type, "message.update");
  assert.equal(replacement.payload.status, "streaming");
  assert.notEqual(text("part2", "new block")[0].payload.messageId, first.payload.messageId);
  const tool = {
    type: "tool_use",
    part: { type: "tool", callID: "t", tool: "read", state: { status: "running", input: {} } }
  };
  assert.equal(n.normalize(tool)[0].type, "tool_call.create");
  assert.deepEqual(n.normalize(tool), []);
  assert.equal(
    n.normalize({
      ...tool,
      part: { ...tool.part, state: { status: "completed", output: "done" } }
    })[0].type,
    "tool_call.update"
  );
});
