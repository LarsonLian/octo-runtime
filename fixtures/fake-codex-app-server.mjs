import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

let initialized = false;
let activeThreadId;

reader.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (message.params?.capabilities?.experimentalApi !== true) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "experimentalApi required" } });
      return;
    }
    initialized = true;
    respond(message.id, { userAgent: "fake-codex-app-server" });
    return;
  }
  if (message.method === "initialized") return;
  if (!initialized) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "not initialized" } });
    return;
  }
  if (message.method === "thread/resume") {
    if (message.params.threadId === "missing-thread") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "thread not found" } });
      return;
    }
    activeThreadId = message.params.threadId;
    respond(message.id, { thread: { id: activeThreadId }, model: "fake-model", modelProvider: "fake" });
    return;
  }
  if (message.method === "thread/start") {
    if (!message.params.cwd || message.params.approvalPolicy !== "never" || !message.params.sandbox) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid thread params" } });
      return;
    }
    activeThreadId = "thread-app-server-1";
    respond(message.id, { thread: { id: activeThreadId }, model: "fake-model", modelProvider: "fake" });
    notify("thread/started", { thread: { id: activeThreadId } });
    return;
  }
  if (message.method === "turn/start") {
    const prompt = message.params.input?.[0]?.text;
    if (message.params.threadId !== activeThreadId || typeof prompt !== "string") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid turn params" } });
      return;
    }
    if (prompt.includes("EXPECT_LOW_EFFORT") && (message.params.effort !== "low" || message.params.summary !== "none")) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "disabled thinking must map to low effort without summary" } });
      return;
    }
    if (!prompt.includes("EXPECT_LOW_EFFORT") && message.params.summary !== "auto") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "default turn must request reasoning summary" } });
      return;
    }
    respond(message.id, { turn: { id: "turn-1", status: "inProgress", items: [] } });
    queueMicrotask(() => {
      notify("turn/started", { threadId: activeThreadId, turn: { id: "turn-1", status: "inProgress", items: [] } });
      if (prompt.includes("WAIT_FOR_CANCEL")) {
        notify("item/started", {
          threadId: activeThreadId,
          turnId: "turn-1",
          item: { type: "agentMessage", id: "message-waiting", text: "" }
        });
        notify("item/agentMessage/delta", {
          threadId: activeThreadId,
          turnId: "turn-1",
          itemId: "message-waiting",
          delta: "waiting"
        });
        return;
      }

      notify("item/started", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: { type: "reasoning", id: "reasoning-1", summary: [], content: [] }
      });
      notify("item/reasoning/textDelta", {
        threadId: activeThreadId,
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "Inspect /tmp."
      });
      notify("item/completed", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: { type: "reasoning", id: "reasoning-1", summary: ["Inspect /tmp."], content: [] }
      });
      notify("item/started", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "tool-1",
          command: "pwd",
          cwd: process.cwd(),
          status: "inProgress"
        }
      });
      notify("item/commandExecution/outputDelta", {
        threadId: activeThreadId,
        turnId: "turn-1",
        itemId: "tool-1",
        delta: "/workspace\n"
      });
      notify("item/completed", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "tool-1",
          command: "pwd",
          cwd: process.cwd(),
          status: "completed",
          aggregatedOutput: "/workspace\n",
          exitCode: 0
        }
      });
      notify("item/started", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: { type: "reasoning", id: "reasoning-2", summary: [], content: [] }
      });
      notify("item/reasoning/textDelta", {
        threadId: activeThreadId,
        turnId: "turn-1",
        itemId: "reasoning-2",
        delta: "Inspect /home/lvsijia."
      });
      notify("item/completed", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: { type: "reasoning", id: "reasoning-2", summary: ["Inspect /home/lvsijia."], content: [] }
      });
      notify("item/started", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "tool-2",
          command: "du -sh /home/lvsijia/*",
          cwd: process.cwd(),
          status: "inProgress"
        }
      });
      notify("item/commandExecution/outputDelta", {
        threadId: activeThreadId,
        turnId: "turn-1",
        itemId: "tool-2",
        delta: "No such file or directory\n"
      });
      notify("item/completed", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: {
          type: "commandExecution",
          id: "tool-2",
          command: "du -sh /home/lvsijia/*",
          cwd: process.cwd(),
          status: "failed",
          aggregatedOutput: "No such file or directory\n",
          exitCode: 1
        }
      });
      notify("item/started", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: { type: "agentMessage", id: "message-1", text: "" }
      });
      notify("item/agentMessage/delta", {
        threadId: activeThreadId,
        turnId: "turn-1",
        itemId: "message-1",
        delta: "App-server reply"
      });
      notify("item/completed", {
        threadId: activeThreadId,
        turnId: "turn-1",
        item: { type: "agentMessage", id: "message-1", text: "App-server reply" }
      });
      notify("thread/tokenUsage/updated", {
        threadId: activeThreadId,
        turnId: "turn-1",
        tokenUsage: {
          total: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
          last: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
          modelContextWindow: 1000
        }
      });
      notify("turn/completed", {
        threadId: activeThreadId,
        turn: { id: "turn-1", status: "completed", items: [] }
      });
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    respond(message.id, {});
    notify("turn/completed", {
      threadId: activeThreadId,
      turn: { id: "turn-1", status: "interrupted", items: [] }
    });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method: ${message.method}` } });
});
