import { prepareInvokeInput } from "../packages/octo-runtime-executor-core/dist/invoke-input.js";
import { imBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
// 协议与展示回归：验证 Context、公开事件投影、卡片合同、终态和投递幂等。
// 服务端 0.4.1 schema fixture 防止合法 TypeScript 对象生成不合法卡片报文。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import {
  ImChannelManager,
  build_im_contexts
} from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import {
  ImRunProjector,
  compactRunes,
  toolPreview
} from "../packages/octo-runtime-extra-channel-gateway/dist/presentation/run-projector.js";
import {
  buildReasoningFrame,
  formatDuration
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/reasoning-frame.js";
import { selectReasoningTemplate } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/cards.js";
import { OctoConnector } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/connector.js";
import { CardSession } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/card-session.js";
import { parseCardAction } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/card-action.js";
import { ImDeliveryDispatcher } from "../packages/octo-runtime-extra-channel-gateway/dist/delivery/dispatcher.js";
import { ProgressScheduler } from "../packages/octo-runtime-extra-channel-gateway/dist/delivery/scheduler.js";
import { TypingController } from "../packages/octo-runtime-extra-channel-gateway/dist/presentation/typing.js";
import { createImInvocation as createChannelInput } from "../packages/octo-runtime-extra-channel-gateway/dist/execution/dispatcher.js";

const template = { ref: { id: "ai.reasoning-process", version: "0.4.0" }, maxPayloadBytes: 16384 };
const event = (type, payload = {}) => ({ protocolVersion: 2, type, payload });
// ESLint already supplies the draft-07 validator used by this fixture.
const Ajv = createRequire(import.meta.resolve("eslint"))("ajv");
const validateReasoningFrame = new Ajv({ allErrors: true }).compile(
  JSON.parse(
    readFileSync(new URL("./fixtures/im-reasoning-contract.json", import.meta.url), "utf8")
  )
);

test("Failure cards show canonical errors before catalog text and keep diagnostics out of the reason budget", () => {
  const projector = new ImRunProjector("failure");
  const message = "Invalid API key. Please run /login. ".repeat(12) + "Bearer private-token";
  projector.accept({ protocolVersion: 2, type: "run.failed", payload: { message } });
  const snapshot = projector.snapshot();
  assert.ok(snapshot.failureDetail.startsWith("Invalid API key. Please run /login."));
  assert.ok(!snapshot.failureDetail.includes("private-token"));
  for (const version of ["0.4.0", "0.4.1"]) {
    const frame = buildReasoningFrame(snapshot, { ...template, ref: { ...template.ref, version } });
    assert.equal(frame.errorTitle, "执行失败");
    assert.match(frame.errorMessage, /^Invalid API key/);
    assert.ok(Array.from(frame.errorMessage).length <= 121);
    assert.match(frame.phases.at(-1).thought, /Please run \/login/);
    assert.ok(validateReasoningFrame(frame), JSON.stringify(validateReasoningFrame.errors));
  }
  const objectError = new ImRunProjector("object-error");
  objectError.accept({
    protocolVersion: 2,
    type: "run.failed",
    payload: { error: { message: "custom adapter failure", code: 17 } }
  });
  assert.match(
    buildReasoningFrame(objectError.snapshot(), template).errorMessage,
    /custom adapter failure/
  );
});
const config = (overrides = {}) => ({
  enabled: true,
  api_url: "http://127.0.0.1:1",
  bot_id: "bot",
  adapter: { adapter_type: "codex", workdir: "/tmp" },
  ...overrides
});
const profile = () => ({
  available: true,
  enabled: true,
  card_version: "1.5",
  profiles: ["octo/v1", "octo/v2"],
  config: {
    card_enabled: true,
    display_enabled: true,
    interaction_enabled: true,
    reasoning_enabled: true,
    reasoning_template_ref: template.ref
  },
  templating: {
    supported: true,
    wire: "template-ref/v1",
    templates: [
      {
        ...template.ref,
        available: true,
        views: [
          {
            name: "active",
            wire_profile: "octo/v2",
            states: ["reasoning", "answering"],
            submit_actions: ["reasoning_stop"]
          },
          {
            name: "error",
            wire_profile: "octo/v2",
            states: ["error"],
            submit_actions: ["reasoning_retry"]
          },
          {
            name: "result",
            wire_profile: "octo/v1",
            states: ["completed", "stopped"],
            submit_actions: []
          }
        ]
      }
    ]
  }
});

async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, "Bearer bf_fixture");
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const request = { path: req.url, body: body ? JSON.parse(body) : undefined };
      requests.push(request);
      res.setHeader("Content-Type", "application/json");
      await handler(request, res);
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { apiUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

test("Canonical projection preserves message identities and excludes private reasoning and tool output", () => {
  const p = new ImRunProjector("run");
  p.accept(
    event("message.delta", {
      messageId: "secret",
      channel: "analysis",
      exposure: "private",
      text: "PRIVATE_SECRET"
    })
  );
  p.accept(
    event("message.update", {
      messageId: "public",
      channel: "analysis",
      exposure: "public_summary",
      text: "public"
    })
  );
  p.accept(event("tool_call.create", { id: "t", name: "shell", args: { cmd: "echo bf_secret" } }));
  p.accept(event("tool_call.update", { id: "t", status: "completed", output: "RAW_SECRET" }));
  p.accept(event("message.delta", { messageId: "one", channel: "final", text: "first" }));
  p.accept(event("message.delta", { messageId: "two", channel: "final", text: "second" }));
  p.accept(event("message.update", { messageId: "one", channel: "final", text: "FIRST" }));
  p.accept(event("run.completed"));
  p.accept(event("message.delta", { channel: "final", text: "late" }));
  assert.equal(p.finalText, "FIRST\n\nsecond");
  const serialized = JSON.stringify(buildReasoningFrame(p.snapshot(), template));
  for (const secret of ["PRIVATE_SECRET", "RAW_SECRET", "bf_secret", "late"])
    assert.ok(!serialized.includes(secret));
  assert.equal(p.snapshot().reasoningCount, 1);
});

test("Model phases prefer commentary, retain tool failures, and never invent thinking", () => {
  const p = new ImRunProjector("run", true);
  p.accept(event("run.started"), 0);
  p.accept(event("model_step.started", { stepId: "s1", startedAtMs: 100 }), 100);
  p.accept(
    event("message.update", {
      messageId: "r",
      channel: "analysis",
      exposure: "public_reasoning",
      text: "reasoning text"
    })
  );
  p.accept(
    event("message.update", { messageId: "c", channel: "commentary", text: "commentary text" })
  );
  p.accept(
    event("tool_call.create", { id: "t", name: "exec_command", args: { cmd: "npm test" } }),
    100
  );
  p.accept(event("tool_call.update", { id: "t", status: "failed", exitCode: 1 }), 1650);
  p.accept(
    event("model_step.finished", {
      stepId: "s1",
      status: "completed",
      finishReason: "tool_calls",
      endedAtMs: 1650
    })
  );
  const frame = buildReasoningFrame(p.snapshot(1650), template);
  assert.match(frame.phases[0].thought, /reasoning text/);
  assert.match(frame.phases[1].thought, /commentary text/);
  assert.match(frame.phases[1].thought, /部分失败/);
  assert.equal(frame.phases[1].actions[0].statusTone, "Attention");
  assert.match(frame.phases[1].actions[0].detail, /npm test.*exit 1.*1.6s/);
  const toolOnly = new ImRunProjector("tools");
  toolOnly.accept(event("tool_call.create", { id: "t", name: "read", args: {} }));
  assert.equal(toolOnly.snapshot().reasoningCount, 0);
  assert.ok(!JSON.stringify(buildReasoningFrame(toolOnly.snapshot(), template)).includes("💭"));
});

test("Answer-only model rounds show public text without inventing a reasoning step", () => {
  const p = new ImRunProjector("run");
  p.accept(event("model_step.started", { stepId: "answer" }));
  p.accept(event("message.update", { messageId: "text", channel: "final", text: "Public answer" }));
  p.accept(
    event("model_step.finished", {
      stepId: "answer",
      status: "completed",
      finishReason: "end_turn"
    })
  );
  const frame = buildReasoningFrame(p.snapshot(), template);
  assert.match(frame.phases[0].thought, /Public answer/);
  assert.equal(frame.phases[0].actions[0].tool, "模型输出");
  assert.equal(p.snapshot().reasoningCount, 0);
  assert.equal(p.snapshot().modelStepCount, 1);
});

test("Structured detector findings remain failed execution facts but display as a warning", () => {
  const p = new ImRunProjector("run");
  p.accept(
    event("tool_call.create", {
      id: "t",
      name: "exec_command",
      args: { cmd: "impeccable detect --json" }
    })
  );
  p.accept(
    event("tool_call.update", {
      id: "t",
      status: "failed",
      exitCode: 2,
      output: '[{"antipattern":"dense layout"}]'
    })
  );
  const snapshot = p.snapshot();
  assert.equal(snapshot.items[0].status, "failed");
  assert.equal(snapshot.items[0].outcome, "check_findings");
  const action = buildReasoningFrame(snapshot, template).phases[0].actions[0];
  assert.equal(action.statusTone, "Attention");
  assert.match(action.detail, /检查发现问题/);
  assert.ok(!JSON.stringify(snapshot).includes("dense layout"));
});

test("Phase/action budgets retain latest phases and full counts with Unicode byte limits", () => {
  const p = new ImRunProjector("run");
  for (let s = 0; s < 6; s++) {
    p.accept(event("model_step.started", { stepId: `s${s}` }));
    p.accept(
      event("message.update", {
        messageId: `c${s}`,
        channel: "commentary",
        text: "开头" + "过程".repeat(200) + "结论"
      })
    );
    for (let t = 0; t < 10; t++)
      p.accept(event("tool_call.create", { id: `${s}-${t}`, name: "read", args: {} }));
  }
  const frame = buildReasoningFrame(p.snapshot(), template);
  assert.equal(frame.phases.length, 3);
  assert.equal(
    frame.phases.reduce((n, phase) => n + phase.actions.length, 0),
    8
  );
  assert.ok(frame.phases.every((phase) => phase.actions.length >= 1));
  assert.match(frame.title, /工具 60/);
  assert.match(frame.phases[0].thought, /第 4 轮/);
  assert.match(compactRunes("开头" + "过程".repeat(200) + "结论", 180), /^开头.*结论$/);
  assert.ok(frame.timerText.length > 0);
  assert.equal(buildReasoningFrame(p.snapshot(), { ...template, maxPayloadBytes: 256 }), undefined);
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ type: 17, template_ref: template.ref, state: frame.state, data: frame })
    ) <
      template.maxPayloadBytes - 128
  );
});

test("Accepted, completed, stopped and unknown states have explicit display semantics", () => {
  const p = new ImRunProjector("run");
  const accepted = buildReasoningFrame(p.snapshot(), template);
  assert.equal(accepted.title, "思考中");
  assert.equal(accepted.statusLabel, "思考中");
  assert.equal(accepted.timerText, undefined);
  assert.equal(accepted.traceCollapsed, true);
  p.accept(event("run.started"), 100);
  p.accept(event("run.cancelled"), 1650);
  const stopped = buildReasoningFrame(p.snapshot(1650), template);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.statusLabel, "已中断");
  assert.equal(stopped.timerText, "1.6s");
  const unknown = buildReasoningFrame(
    { ...new ImRunProjector("unknown").snapshot(), resultUnknown: true },
    template
  );
  assert.equal(unknown.statusLabel, "结果未知");
  assert.equal(unknown.state, "stopped");
  assert.deepEqual([0, 999, 1000, 1550, 65000].map(formatDuration), [
    "0ms",
    "999ms",
    "1s",
    "1.6s",
    "1m 5s"
  ]);
});

test("Real template schema accepts first activity, intermediate phases and all terminal states", () => {
  const currentTemplate = { ...template, ref: { ...template.ref, version: "0.4.1" } };
  const p = new ImRunProjector("run-contract", true);
  const check = (snapshot) => {
    const frame = buildReasoningFrame(snapshot, currentTemplate);
    assert.ok(validateReasoningFrame(frame), JSON.stringify(validateReasoningFrame.errors));
    return frame;
  };
  assert.equal(check(p.snapshot()).statusLabel, "思考中");
  p.accept(event("activity.started", { kind: "starting" }), 100);
  p.accept(event("model_step.started", { stepId: "one-provider-turn" }), 100);
  assert.equal(check(p.snapshot(200)).timerText, "100ms");
  p.accept(
    event("message.update", { messageId: "progress-1", channel: "commentary", text: "先查资料" }),
    300
  );
  p.accept(event("tool_call.create", { id: "search-1", name: "search", args: {} }), 400);
  p.accept(event("tool_call.update", { id: "search-1", status: "completed" }), 500);
  p.accept(
    event("message.update", { messageId: "progress-2", channel: "commentary", text: "再核对来源" }),
    600
  );
  p.accept(event("tool_call.create", { id: "search-2", name: "search".repeat(30), args: {} }), 700);
  const active = check(p.snapshot(800));
  assert.deepEqual(
    active.phases.map((phase) => phase.thought.split("：").at(-1)),
    ["先查资料", "再核对来源"]
  );
  assert.equal(active.phases[0].actions[0].tool, "🔎 search");
  assert.ok(!active.phases[0].actions.some((action) => action.tool.includes("…")));
  assert.ok(Array.from(active.phases[1].actions[0].tool).length <= 81);
  p.accept(
    event("message.update", { messageId: "final", channel: "final", text: "最终消息" }),
    900
  );
  for (const terminal of ["completed", "failed", "cancelled"]) {
    const snapshot = { ...p.snapshot(1000), terminal };
    if (terminal === "failed")
      snapshot.failure = {
        code: "model_rate_limited",
        diagnosticId: "diagnostic",
        action: { type: "retry_later" }
      };
    check(snapshot);
  }
  check({ ...p.snapshot(1000), resultUnknown: true });
  const unknownStart = new ImRunProjector("unknown-start");
  unknownStart.accept(event("tool_call.create", { id: "tool", name: "read", args: {} }));
  assert.equal(check(unknownStart.snapshot()).timerText, undefined);
});

test("Tool previews are bounded and redact common credential-bearing commands and paths", () => {
  assert.equal(toolPreview("exec_command", { cmd: "bash -lc 'npm test'" }), "npm test");
  assert.equal(toolPreview("exec_command", { cmd: "TOKEN=abc curl example.com" }), "");
  assert.equal(toolPreview("read", { path: "/private/account/.env" }), "");
  assert.equal(toolPreview("read", { path: "/work/project/src/main.ts" }), "…/src/main.ts");
  assert.ok(Array.from(toolPreview("bash", { cmd: "x".repeat(100) })).length <= 42);
});

test("Template negotiation fails closed on missing, unavailable and ambiguous capabilities", () => {
  assert.deepEqual(selectReasoningTemplate(profile()), template);
  for (const mutate of [
    (p) => (p.available = false),
    (p) => (p.config.reasoning_enabled = false),
    (p) => (p.templating.templates[0].available = false),
    (p) => (p.templating.templates[0].views[0].states = ["reasoning"]),
    (p) => p.templating.templates.push(structuredClone(p.templating.templates[0]))
  ]) {
    const p = profile();
    mutate(p);
    assert.equal(selectReasoningTemplate(p), undefined);
  }
});

test("Progress terminal overtakes pending frames and waits for an in-flight send", async () => {
  let release;
  const sent = [];
  const scheduler = new ProgressScheduler(
    async (value) => {
      sent.push(value);
      if (value === "initial") await new Promise((resolve) => (release = resolve));
    },
    () => assert.fail(),
    10
  );
  scheduler.enqueue("initial");
  const flushing = scheduler.flush();
  scheduler.enqueue("obsolete");
  scheduler.enqueue("terminal", true);
  scheduler.enqueue("late");
  release();
  await flushing;
  assert.deepEqual(sent, ["initial", "terminal"]);
});

test("Typing leases keep other runs alive and release all timers on close", async () => {
  const sent = [];
  const typing = new TypingController(
    async (address, signal) => sent.push({ address, signal }),
    () => assert.fail(),
    10,
    1000
  );
  const address = { channelId: "peer", channelType: 1 };
  const first = typing.acquire(address, "one"),
    second = typing.acquire(address, "two");
  await delay(15);
  first();
  assert.equal(typing.activeAddresses, 1);
  second();
  assert.equal(typing.activeAddresses, 0);
  assert.equal(sent[0].signal.aborted, true);
  typing.acquire(address, "three");
  typing.close();
  const count = sent.length;
  await delay(20);
  assert.equal(sent.length, count);
  assert.equal(typing.activeAddresses, 0);
});

test("Group/topic rules become ordered v3 items; history excludes the trigger and is sorted", async (t) => {
  let mode = "normal";
  const f = await fixture(t, ({ path }, res) => {
    if (path.endsWith("/threads/topic/md")) {
      if (mode === "missing") {
        res.statusCode = 404;
        res.end("{}");
        return;
      }
      if (mode === "forbidden") {
        res.statusCode = 403;
        res.end("{}");
        return;
      }
      res.end(JSON.stringify({ content: "topic text", version: 2, updated_at: null }));
    } else if (path.endsWith("/groups/group/md"))
      res.end(JSON.stringify({ content: "group text", version: 1, updated_at: null }));
    else if (path.endsWith("/messages/sync")) {
      if (mode === "history_failure") {
        res.statusCode = 500;
        res.end("{}");
        return;
      }
      res.end(
        JSON.stringify({
          messages: [9, 3, 7, 10].map((seq) => ({
            message_id: String(seq),
            message_seq: seq,
            from_uid: "peer",
            timestamp: 1,
            payload: Buffer.from(JSON.stringify({ type: 1, content: `text ${seq}` })).toString(
              "base64"
            )
          }))
        })
      );
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  const bot = {
    ...config({ api_url: f.apiUrl }),
    spaceId: "s"
  };
  const message = {
    messageId: "9",
    messageSeq: 9,
    fromUid: "peer",
    channelId: "group____topic",
    channelType: 5,
    payload: { type: 1, content: "request" }
  };
  const read = () =>
    build_im_contexts(bot, message, "bf_fixture", new AbortController().signal, {
      initialSession: true
    });
  const items = await read();
  assert.deepEqual(
    items.map((item) => [item.namespace, item.name]),
    [
      ["extra.im", "group-rules"],
      ["extra.im", "topic-rules"],
      ["extra.im", "mention-instructions"],
      ["extra.im", "history"]
    ]
  );
  assert.equal(items[3].payload.text, "peer：text 3\npeer：text 7");
  assert.equal(items[0].payload.text, "group text");
  assert.equal(items[1].payload.version, 2);
  const again = await read();
  assert.deepEqual(again, items);
  assert.equal(f.requests.length, 6);
  mode = "missing";
  assert.equal((await read())[1].payload.status, "not_found");
  mode = "forbidden";
  await assert.rejects(read(), (error) => error.status === 403);
  mode = "history_failure";
  assert.equal(
    (await read()).some((item) => item.name === "history"),
    false
  );
});

test("Empty Context remains empty and per-run snapshots do not mutate the caller", async () => {
  const bot = config();
  const items = await build_im_contexts(
    bot,
    { channelType: 1 },
    "bf_fixture",
    new AbortController().signal
  );
  assert.deepEqual(items, []);
  const context = {
    schema: "octo.context-envelope/v3",
    items: [{ namespace: "extra.im", name: "group-rules", payload: { text: "original" } }]
  };
  const message = { messageId: "m", senderId: "peer", conversationId: "channel", text: "request" };
  const session = { id: "session", generation: 1 };
  const { request: first } = createImInvocation(
    bot,
    message,
    context,
    "key",
    session,
    new AbortController().signal
  );
  const { request: second } = createImInvocation(
    bot,
    message,
    context,
    "key",
    session,
    new AbortController().signal
  );
  context.items[0].payload.text = "changed";
  assert.equal(
    first.context.items.find((item) => item.namespace === "extra.im").payload.text,
    "original"
  );
  assert.deepEqual(second.context, first.context);
  assert.notEqual(second.runId, first.runId);
  assert.equal(first.modelInput, "request");
  assert.equal(first.approvalMode, "full_access");
});

test("Channel public input keeps automatic material budget fallback without dropping explicit items", () => {
  const context = {
    schema: "octo.context-envelope/v3",
    items: [
      ...Array.from({ length: 28 }, (_, i) => ({
        namespace: "extra.business",
        name: `item-${i}`,
        payload: {}
      })),
      { namespace: "extra.im", name: "history", payload: { automatic: true, text: "history" } },
      {
        namespace: "extra.im",
        name: "mention-instructions",
        payload: { automatic: true, text: "guidance" }
      }
    ]
  };
  const create = () =>
    createChannelInput(
      config(),
      { messageId: "budget", senderId: "actor", conversationId: "channel", text: "request" },
      context,
      "key",
      { id: "session", generation: 1 },
      new AbortController().signal
    );
  const { request } = create();
  assert.equal(request.contexts.items.length, 32);
  assert.equal(
    request.contexts.items.filter((item) => item.namespace === "extra.business").length,
    28
  );
  assert.equal(
    request.contexts.items.some((item) => item.namespace === "extra.im"),
    false
  );
  assert.equal(context.items.length, 30);
  context.items.at(-2).payload.automatic = false;
  assert.throws(create, /CONTEXT_BUDGET_EXCEEDED/);
});

test("Execution choices preserve the fixed IM Agent directory without entering request text", () => {
  const context = {
    schema: "octo.context-envelope/v3",
    items: [
      { namespace: "octo.execution", name: "adapter", payload: { type: "claude-code" } },
      {
        namespace: "octo.execution",
        name: "workspace",
        payload: { mode: "fixed", path: "/tmp" }
      },
      {
        namespace: "octo.execution",
        name: "model",
        payload: { selection: { id: "model" }, reasoning: { effort: "high" } }
      },
      { namespace: "octo.security", name: "approval_policy", payload: { mode: "assisted" } }
    ]
  };
  const { request, adapterType } = createImInvocation(
    config(),
    { messageId: "m", senderId: "actor", conversationId: "channel", text: "request" },
    context,
    "key",
    { id: "session", generation: 1 },
    new AbortController().signal
  );
  assert.equal(adapterType, "claude-code");
  assert.equal(request.agentConfig.model, "model");
  assert.equal(request.agentConfig.effort, "high");
  assert.equal(request.workdir, "/tmp");
  assert.equal(request.approvalMode, "assisted");
  assert.equal(request.modelInput, "request");
  context.items.find((item) => item.name === "workspace").payload.path = "/tmp/other";
  assert.throws(
    () =>
      createImInvocation(
        config(),
        { text: "request", senderId: "actor", conversationId: "channel", messageId: "m" },
        context,
        "key",
        { id: "session", generation: 2 },
        new AbortController().signal
      ),
    /IM_AGENT_WORKDIR_FIXED/
  );
});

test("Cards create/edit one stable message with monotone card_seq and persistent terminal", async (t) => {
  const f = await fixture(t, ({ path }, res) => {
    if (path === "/v1/bot/card/profile") res.end(JSON.stringify(profile()));
    else if (path === "/v1/bot/sendMessage") res.end('{"message_id":9223372036854775801}');
    else res.end("{}");
  });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const connector = new OctoConnector(
    config({ api_url: f.apiUrl }),
    "bf_fixture",
    abort.signal,
    async () => {}
  );
  const delivery = new ImDeliveryDispatcher(abort.signal);
  let stopped = 0;
  const card = new CardSession(
    connector,
    delivery,
    { channelId: "peer", channelType: 1 },
    "run",
    () => stopped++,
    () => assert.fail()
  );
  const p = new ImRunProjector("run");
  card.update(p.snapshot());
  await card.finish();
  assert.equal(card.messageId, "9223372036854775801");
  p.accept(event("run.started"));
  p.accept(event("message.delta", { channel: "final", text: "answer" }));
  card.update(p.snapshot());
  await card.finish();
  p.accept(event("run.completed"));
  card.update(p.snapshot());
  await card.finish();
  card.update({ ...p.snapshot(), terminal: undefined, phase: "thinking" });
  await card.finish();
  const sends = f.requests.filter((request) => request.path === "/v1/bot/sendMessage");
  const edits = f.requests.filter((request) => request.path === "/v1/bot/message/edit");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.payload.type, 17);
  assert.deepEqual(
    edits.map((request) => request.body.card_seq),
    [2, 3]
  );
  assert.equal(edits[0].body.transient, true);
  assert.equal(edits[1].body.transient, undefined);
  assert.equal(edits[1].body.message_id, "9223372036854775801");
  assert.equal(edits[1].body.state, "completed");
  assert.ok(stopped > 0);
  assert.equal(f.requests.filter((request) => request.path === "/v1/bot/card/profile").length, 1);
});

test("Delivery retries use one effect key and never rerun execution", async () => {
  const delivery = new ImDeliveryDispatcher(new AbortController().signal);
  let attempts = 0;
  const operation = async () => {
    if (++attempts < 2) throw new Error("lost ACK");
    return "message";
  };
  assert.equal((await delivery.deliver("key", operation)).state, "delivered");
  await delivery.deliver("key", operation);
  assert.equal(attempts, 2);
  assert.equal(
    (
      await delivery.deliver(
        "transient",
        async () => {
          throw new Error("lost ACK");
        },
        { transient: true }
      )
    ).state,
    "unknown"
  );
});

test("Dynamic endpoints retain startup errors independently and remove idempotently", async (t) => {
  const manager = new ImChannelManager({ host: { cancel: async () => ({ cancelled: true }) } });
  t.after(() => manager.close());
  await manager.upsert(config());
  await manager.upsert(config({ bot_id: "other" }));
  await manager.upsert(Object.fromEntries(Object.entries(config()).reverse()));
  assert.ok(
    manager.status.every(
      (endpoint) => endpoint.state === "failed" && endpoint.error === "IM_CREDENTIALS_REQUIRED"
    )
  );
  await manager.upsert(config({ bf_token: "invalid" }));
  assert.equal(manager.status[0].state, "failed");
  assert.equal(manager.status[0].error, "IM_BOT_TOKEN_INVALID");
  assert.equal(manager.status[1].error, "IM_CREDENTIALS_REQUIRED");
  await manager.upsert(config());
  assert.equal(manager.status[0].state, "failed");
  await manager.upsert(config());
  assert.equal(manager.status.length, 2, "same Bot replaces one entry");
  await manager.remove(imBotIdentity(config()));
  await manager.remove(imBotIdentity(config()));
  assert.equal(manager.status.length, 1);
  await manager.upsert(config());
  assert.equal(manager.status.length, 2);
  assert.ok(manager.status.every((endpoint) => !("revision" in endpoint)));
  assert.ok(!JSON.stringify(manager.status).includes("token"));
});

test("Card action parsing uses server actor/address rather than untrusted submitted inputs", () => {
  const action = parseCardAction({
    event_id: 1,
    event_type: "card_action",
    event_data: {
      message_id: "card",
      channel_id: "peer",
      channel_type: 1,
      action_id: "reasoning_stop",
      operator_uid: "real",
      space_id: "s",
      inputs: { operator_uid: "forged", number: 0, toggle: false }
    }
  });
  assert.equal(action.operatorUid, "real");
  assert.equal(action.inputs.number, "0");
  assert.equal(action.inputs.toggle, "false");
  assert.equal(parseCardAction({ event_id: 2, event_type: "doc_mention", event_data: {} }), null);
});

const createImInvocation = (...args) => {
  const result = createChannelInput(...args);
  return { ...result, request: prepareInvokeInput(result.request).request };
};
