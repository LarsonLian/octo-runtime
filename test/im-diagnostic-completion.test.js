import test from "node:test";
import assert from "node:assert/strict";
import { CodexEventNormalizer } from "../packages/octo-runtime-adapter-codex/dist/index.js";
import { assertCanonicalEvent } from "../packages/octo-runtime-protocol/dist/index.js";
import { ImRunProjector } from "../packages/octo-runtime-extra-channel-gateway/dist/presentation/run-projector.js";
import { buildReasoningFrame } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/reasoning-frame.js";

const event = (type, payload = {}) => ({ protocolVersion: 2, type, payload });
const diagnostic = (message = "Synthetic authentication failure") =>
  event("run.notice", {
    noticeId: "diagnostic-1",
    code: "provider_diagnostic",
    severity: "warning",
    params: { adapter: "codex", diagnosticId: "diag-1", category: "authentication", message }
  });
const retry = () =>
  event("run.notice", {
    noticeId: "retry-1",
    code: "retry_scheduled",
    severity: "warning",
    params: { attempt: 2 }
  });
const answer = (text, channel = "final") =>
  event("message.update", {
    role: "assistant",
    channel,
    messageId: "answer",
    text
  });
const template = { ref: { id: "ai.reasoning-process", version: "0.4.0" }, maxPayloadBytes: 16384 };

test("Codex emits one bounded first diagnostic without changing the turn terminal", () => {
  const n = new CodexEventNormalizer();
  const events = n.normalize({
    method: "error",
    params: {
      willRetry: false,
      error: {
        message: "Authentication failed token=hidden " + "中".repeat(3000),
        codexErrorInfo: "unauthorized"
      }
    }
  });
  const notice = events.find((e) => e.type === "run.notice");
  assert.equal(notice?.payload.code, "provider_diagnostic");
  assert.ok(Buffer.byteLength(notice.payload.params.message) <= 2048);
  assert.doesNotMatch(notice.payload.params.message, /hidden|\ufffd/);
  assertCanonicalEvent(notice);
  assert.equal(
    n
      .normalize({ method: "error", params: { error: { message: "later" } } })
      .some((e) => e.type === "run.notice"),
    false
  );
  assert.equal(
    n.normalize({ method: "error", params: { willRetry: true } })[0].payload.code,
    "retry_scheduled"
  );
  assert.equal(
    n.normalize({ method: "turn/completed", params: { turn: { status: "completed" } } }).at(-1)
      .type,
    "run.completed"
  );
});

test("normal Codex execution adds no diagnostic notices", () => {
  const n = new CodexEventNormalizer();
  const events = [
    ...n.normalize({ method: "turn/started", params: { turn: { id: "turn" } } }),
    ...n.normalize({
      method: "item/completed",
      params: { item: { id: "answer", type: "agentMessage", text: "Normal reply" } }
    }),
    ...n.normalize({ method: "turn/completed", params: { turn: { status: "completed" } } })
  ];
  assert.equal(
    events.some((e) => e.type === "run.notice"),
    false
  );
});

test("provider diagnostics validate bounded, typed metadata", () => {
  assert.doesNotThrow(() => assertCanonicalEvent(diagnostic()));
  for (const params of [
    { ...diagnostic().payload.params, message: "中".repeat(1000) },
    { ...diagnostic().payload.params, diagnosticId: "" },
    { ...diagnostic().payload.params, category: 123 },
    { ...diagnostic().payload.params, retryable: true },
    { ...diagnostic().payload.params, message: "" }
  ])
    assert.throws(() =>
      assertCanonicalEvent(event("run.notice", { ...diagnostic().payload, params }))
    );
});

for (const text of [
  undefined,
  "",
  " \n\t",
  "\u200b\u2060",
  "---",
  "<!-- hidden -->",
  "[ref]: https://example.com",
  "```\n\n```",
  "> \n"
]) {
  test(`diagnostic with no deliverable final: ${JSON.stringify(text)}`, () => {
    const p = new ImRunProjector("run");
    p.accept(diagnostic());
    if (text !== undefined) p.accept(answer(text));
    p.accept(event("run.completed"));
    assert.equal(p.snapshot().terminal, "completed");
    assert.equal(p.snapshot().replyAssessment, "needs_verification");
    assert.match(p.finalReply.text, /请核查任务结果，避免重复执行/);
    assert.match(p.finalReply.text, /Synthetic authentication failure/);
    const frame = buildReasoningFrame(p.snapshot(), template);
    assert.equal(frame.state, "stopped");
    assert.equal(frame.statusLabel, "结果待核查");
    assert.equal(frame.statusTone, "Warning");
    assert.doesNotMatch(JSON.stringify(frame), /reasoning_retry|已完成/);
  });
}

test("final snapshots erase earlier text and analysis/commentary cannot clear diagnostics", () => {
  const p = new ImRunProjector("run");
  p.accept(diagnostic("first error"));
  p.accept(answer("partial"));
  p.accept(answer(""));
  p.accept(answer("progress only", "commentary"));
  p.accept(retry());
  p.accept(diagnostic("later error"));
  p.accept(event("run.completed"));
  assert.equal(p.snapshot().replyAssessment, "needs_verification");
  assert.match(p.finalReply.text, /first error/);
  assert.doesNotMatch(p.finalReply.text, /later error|progress only/);
});

for (const text of [
  "Recovered",
  "```js\nconsole.log(1)\n```",
  "![result](https://example.com/image.png)",
  "![result][ref]\n\n[ref]: https://example.com/image.png",
  "<div>Recovered</div>"
]) {
  test(`recovered reply is delivered normally: ${text}`, () => {
    const p = new ImRunProjector("run");
    p.accept(diagnostic());
    p.accept(retry());
    p.accept(answer(text));
    p.accept(event("run.completed"));
    assert.equal(p.finalReply.text, text);
    assert.equal(p.finalReply.allowMention, true);
    assert.equal(p.snapshot().replyAssessment, "ready");
    assert.equal(p.snapshot().providerDiagnostic.message, "Synthetic authentication failure");
    assert.equal(buildReasoningFrame(p.snapshot(), template).statusLabel, "已完成");
  });
}

test("retry-only silent completion is cautious; clean silent completion remains valid", () => {
  const p = new ImRunProjector("retry");
  p.accept(retry());
  p.accept(event("run.completed"));
  assert.equal(p.snapshot().replyAssessment, "needs_verification");
  assert.match(p.finalReply.text, /未收到可确认的回复/);
  const clean = new ImRunProjector("clean");
  clean.accept(event("run.completed"));
  assert.equal(clean.snapshot().replyAssessment, "empty");
  assert.equal(clean.finalReply.text, "执行已结束，未返回文本。");
});

test("terminal failure/cancel override diagnostics and a fresh projector isolates attempts", () => {
  for (const terminal of ["run.failed", "run.cancelled"]) {
    const p = new ImRunProjector("run");
    p.accept(diagnostic("earlier"));
    p.accept(event(terminal, { message: "terminal reason" }));
    assert.notEqual(p.snapshot().replyAssessment, "needs_verification");
    assert.doesNotMatch(p.finalReply.text, /earlier/);
    if (terminal === "run.failed") assert.match(p.finalReply.text, /terminal reason/);
  }
  const fresh = new ImRunProjector("new-attempt");
  fresh.accept(event("run.completed"));
  assert.equal(fresh.snapshot().providerDiagnostic, undefined);
  assert.equal(fresh.snapshot().replyAssessment, "empty");
});
