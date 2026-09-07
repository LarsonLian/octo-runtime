const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const prompt = Buffer.concat(chunks).toString("utf8");
if (prompt !== "work") throw new Error(`unexpected prompt: ${prompt}`);
if (!process.argv.includes("--include-partial-messages")) {
  throw new Error("partial messages must be enabled");
}

const send = event => process.stdout.write(`${JSON.stringify(event)}\n`);
const stream = event => send({
  type: "stream_event",
  session_id: "claude-partial-1",
  parent_tool_use_id: null,
  event
});

send({ type: "system", subtype: "init", session_id: "claude-partial-1" });
stream({ type: "message_start", message: { id: "message-1" } });
stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "检查 /tmp。" } });
send({
  type: "assistant",
  session_id: "claude-partial-1",
  message: { content: [{ type: "thinking", thinking: "检查 /tmp。" }] }
});
stream({ type: "content_block_stop", index: 0 });
stream({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "tool-1", name: "Bash", input: {} }
});
stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":" } });
stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"find /tmp\"}" } });
send({
  type: "assistant",
  session_id: "claude-partial-1",
  message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "find /tmp" } }] }
});
stream({ type: "content_block_stop", index: 1 });
stream({ type: "message_delta", delta: { stop_reason: "tool_use" } });
stream({ type: "message_stop" });
send({
  type: "user",
  session_id: "claude-partial-1",
  message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "/tmp/largest" }] }
});
send({ type: "system", subtype: "status", session_id: "claude-partial-1" });

stream({ type: "message_start", message: { id: "message-2" } });
stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "检查 /home/lvsijia。" } });
stream({ type: "content_block_stop", index: 0 });
stream({
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "tool-2", name: "Bash", input: {} }
});
stream({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"command\":\"du /home/lvsijia\"}" } });
stream({ type: "content_block_stop", index: 1 });
stream({ type: "message_delta", delta: { stop_reason: "tool_use" } });
stream({ type: "message_stop" });
send({
  type: "user",
  session_id: "claude-partial-1",
  message: { content: [{ type: "tool_result", tool_use_id: "tool-2", content: "No such file or directory" }] }
});

stream({ type: "message_start", message: { id: "message-3" } });
stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "两步检查完成。" } });
stream({ type: "content_block_stop", index: 0 });
stream({ type: "message_delta", delta: { stop_reason: "end_turn" } });
stream({ type: "message_stop" });
send({
  type: "assistant",
  session_id: "claude-partial-1",
  message: { content: [{ type: "text", text: "两步检查完成。" }] }
});
send({
  type: "result",
  session_id: "claude-partial-1",
  is_error: false,
  result: "两步检查完成。",
  usage: { input_tokens: 10, output_tokens: 5 }
});
