import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import {
  interactionCard,
  interactionAnswer
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/interaction-card.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
const request = () => ({
  interactionId: "question",
  executionInstanceId: "instance",
  kind: "question",
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  request: {
    questions: [
      {
        id: "design",
        question: "选择方案",
        options: [{ label: "A", description: "方案 A" }, { label: "B" }]
      },
      { id: "reason", question: "说明原因" }
    ]
  }
});
test("F09: canonical questions project choices and custom input; structured answers and expiration are enforced", () => {
  const pending = request(),
    card = interactionCard(pending);
  assert.equal(card.body.filter((node) => node.type === "Input.ChoiceSet").length, 1);
  assert.equal(card.body.filter((node) => node.type === "Input.Text").length, 2);
  const action = { actionId: "interaction_answered", inputs: { q0: "A", custom1: "because" } };
  assert.deepEqual(interactionAnswer(pending, action).value, {
    design: { answers: ["A"] },
    reason: { answers: ["because"] }
  });
  assert.equal(
    interactionAnswer(pending, { ...action, inputs: { ...action.inputs, custom0: "custom" } }).value
      .design.answers[0],
    "custom"
  );
  assert.throws(
    () => interactionAnswer(pending, { ...action, inputs: { q0: "unknown", custom1: "reason" } }),
    /REQUIRED/
  );
  assert.throws(
    () => interactionAnswer({ ...pending, expiresAt: new Date(0).toISOString() }, action),
    /EXPIRED/
  );
  assert.equal(interactionCard(pending, "resolved").actions, undefined);
  const elicitation = {
    ...pending,
    kind: "elicitation",
    request: { message: "fill", requestedSchema: { type: "object" } }
  };
  assert.deepEqual(
    interactionAnswer(elicitation, { ...action, inputs: { answer: '{"accepted":true}' } }).value,
    { accepted: true }
  );
  assert.throws(
    () =>
      interactionCard({ ...pending, request: { questions: [{ id: "secret", isSecret: true }] } }),
    /UNSUPPORTED/
  );
});

test("F09: card answer resumes original invocation once and stale reset cards cannot answer", async (t) => {
  let receive, controls, release;
  const answerGate = new Promise((resolve) => {
    release = resolve;
  });
  const responses = [],
    calls = [],
    resolved = [];
  const pending = request();
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = this.callbacks.onMessage;
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  const runtime = new ImRuntime(
    {
      bot_id: "fixture",
      api_url: "https://im-test.deepminer.com.cn/api",
      adapter: { adapter_type: "codex" }
    },
    {
      host: {
        async *invoke(input) {
          calls.push(input.invocationId);
          yield { protocolVersion: 2, type: "interaction.requested", payload: pending };
          await answerGate;
          yield {
            protocolVersion: 2,
            type: "interaction.resolved",
            payload: {
              interactionId: pending.interactionId,
              executionInstanceId: "instance",
              status: "resolved",
              outcome: "answered"
            }
          };
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async respondInteraction(id, response) {
          responses.push({ id, response });
          release();
        },
        async cancel() {
          release();
          return { cancelled: true };
        }
      }
    }
  );
  await runtime.start();
  t.after(() => runtime.close());
  const message = {
    messageId: "m",
    senderId: "owner",
    conversationId: "chat",
    conversationKind: "direct",
    text: "work",
    async reply() {},
    async buildContext() {
      return { schema: "octo.context-envelope/v3", items: [] };
    },
    beginPresentation(_id, _diagnostic, value) {
      controls = value;
      return {
        async interaction(value) {
          assert.deepEqual(value, pending);
          return true;
        },
        async resolveInteraction(id) {
          resolved.push(id);
        },
        update() {},
        async finish() {}
      };
    }
  };
  receive(message);
  await settle();
  const response = interactionAnswer(pending, {
    actionId: "interaction_answered",
    inputs: { q0: "A", custom1: "reason" }
  });
  await controls.respond(response);
  await assert.rejects(() => controls.respond(response));
  for (let i = 0; i < 10 && runtime.status.sessions.length; i++) await settle();
  assert.equal(calls.length, 1);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, calls[0]);
  assert.deepEqual(resolved, ["question"]);
  receive({ ...message, messageId: "m2" });
  await settle();
  receive({ ...message, text: "/reset", messageId: "reset" });
  await settle();
  await assert.rejects(() => controls.respond(response));
});
