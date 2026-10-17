import { createInterface } from "node:readline";

let sessionId = "sess-zcode-fixture";
let seq = 0;
let pendingCreate;
let permissionRequestId;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function event(type, payload = {}) {
  send({ method: "session/event", params: { sessionId, seq: ++seq, type, payload } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 900 && message.result) {
    if (pendingCreate !== undefined) {
      send({ id: pendingCreate, result: { session: { sessionId } } });
      pendingCreate = undefined;
    }
    return;
  }
  if (message.id === 901 && message.result) {
    permissionRequestId = message.result.decision;
    queueMicrotask(() => {
      event("turn.started", { turnId: "turn-fixture" });
      event("model.streaming", { kind: "reasoning_delta", delta: "checking" });
      event("model.streaming", { kind: "text_delta", delta: `permission:${permissionRequestId}` });
      event("model.streaming", {
        kind: "tool_call",
        toolCallId: "tool-1",
        toolName: "Write",
        input: { path: "zcode.html" }
      });
      event("tool.updated", {
        kind: "scheduled",
        toolCallId: "tool-1",
        toolName: "Write",
        inputOmitted: true
      });
      event("tool.updated", { kind: "started", toolCallId: "tool-1" });
      event("tool.updated", { kind: "result", toolCallId: "tool-1", result: { ok: true } });
      event("turn.completed", {
        turnId: "turn-fixture",
        resultType: "success",
        usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 }
      });
    });
    return;
  }
  if (message.method === "session/resume") {
    send({ id: message.id, error: { code: 404, message: "session not found" } });
    return;
  }
  if (message.method === "session/create") {
    pendingCreate = message.id;
    send({
      id: 900,
      method: "session/requestRuntimePreferences",
      params: { sessionId }
    });
    return;
  }
  if (message.method === "session/subscribe") {
    send({ id: message.id, result: { eventSeq: seq } });
    return;
  }
  if (message.method === "session/send") {
    send({ id: message.id, result: { accepted: true } });
    send({
      id: 901,
      method: "interaction/requestPermission",
      params: {
        requestId: "permission-fixture",
        sessionId,
        toolCallId: "tool-1",
        toolName: "Write",
        input: { path: "zcode.html" },
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
          { optionId: "deny", kind: "deny_once", name: "Deny" }
        ]
      }
    });
  }
});
