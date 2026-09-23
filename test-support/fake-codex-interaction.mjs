import { createInterface } from "node:readline";

const reader = createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ id, result });

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function requestApproval() {
  send({
    id: "interactive-approval",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-interaction",
      turnId: "turn-interaction",
      itemId: "command-1",
      reason: "Install the requested dependency",
      command: "pnpm add example",
      cwd: "/workspace"
    }
  });
}

function requestElicitation() {
  send({
    id: "interactive-elicitation",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread-interaction",
      turnId: "turn-interaction",
      serverName: "octo-integration",
      mode: "openai/userVerification",
      title: "Verify account",
      description: "Confirm the linked account",
      challenge: "provider-secret-challenge",
      _meta: { token: "provider-secret-meta" }
    }
  });
}

function requestUserInput() {
  send({
    id: 9001,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-interaction",
      turnId: "turn-interaction",
      itemId: "question-1",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [{
        id: "language",
        header: "Language",
        question: "Which language should be used?",
        isOther: true,
        isSecret: false,
        options: [{ label: "TypeScript", description: "Use strict TypeScript" }]
      }]
    }
  });
}

function completeTurn() {
  send({
    method: "turn/completed",
    params: {
      threadId: "thread-interaction",
      turnId: "turn-interaction",
      turn: { id: "turn-interaction", status: "completed" }
    }
  });
}

reader.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return reply(message.id, {});
  if (message.method === "thread/start") return reply(message.id, { thread: { id: "thread-interaction" } });
  if (message.method === "turn/start") {
    reply(message.id, { turn: { id: "turn-interaction" } });
    requestApproval();
    return;
  }
  if (message.id === "interactive-approval") {
    if (message.result?.decision !== "accept") fail("approval response was not accepted");
    requestElicitation();
    return;
  }
  if (message.id === "interactive-elicitation") {
    const expected = { action: "accept", content: { account: "verified" }, _meta: null };
    if (JSON.stringify(message.result) !== JSON.stringify(expected)) fail("elicitation response did not match");
    requestUserInput();
    return;
  }
  if (message.id === 9001) {
    const expected = { answers: { language: { answers: ["TypeScript"] } } };
    if (JSON.stringify(message.result) !== JSON.stringify(expected)) fail("question response did not match");
    completeTurn();
  }
});
