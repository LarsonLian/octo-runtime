import { preparedFrames } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import {
  createCodexAdapter,
  CodexEventNormalizer
} from "@mininglamp-oss/octo-runtime-adapter-codex";
import {
  createClaudeCodeAdapter,
  ClaudeEventNormalizer
} from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { sanitizePublicValue } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { ImRunProjector } from "../packages/octo-runtime-extra-channel-gateway/dist/presentation/run-projector.js";
import { buildReasoningFrame } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/reasoning-frame.js";
import { invokeRequest } from "./runtime-fixture.js";
import { classifyFailure } from "@mininglamp-oss/octo-runtime-protocol";

test("Codex structured upstream failures survive canonical normalization and catalog classification", () => {
  for (const [codexErrorInfo, expected] of [
    ["rateLimitExceeded", "OH-PRV-4005"],
    ["serverOverloaded", "OH-PRV-4006"],
    ["internalServerError", "OH-PRV-4006"],
    ["unauthorized", "OH-PRV-4001"],
    ["usageLimitExceeded", "OH-PRV-4004"],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, "OH-PRV-4006"],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 503 } }, "OH-PRV-4006"],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, "OH-PRV-4001"],
    [{ responseStreamConnectionFailed: { httpStatusCode: 403 } }, "OH-PRV-4002"]
  ]) {
    const error = { message: "Provider request failed", codexErrorInfo };
    const failed = new CodexEventNormalizer()
      .normalize({ method: "turn/completed", params: { turn: { status: "failed", error } } })
      .find((e) => e.type === "run.failed");
    assert.deepEqual(failed.payload.error, error);
    const failure = classifyFailure(failed.payload, {
      stage: "provider.invoke",
      defaultDomain: "provider",
      source: { component: "octo-runtime", adapter: "codex" }
    });
    assert.equal(failure.code, expected);
  }
});

async function failed(adapter, workdir = process.cwd()) {
  const host = new AdapterHost();
  host.register(adapter);
  const events = [];
  for await (const frame of preparedFrames(
    host,
    adapter.metadata.type,
    invokeRequest({ workdir, approvalMode: "full_access" }),
    { protocolMode: "canonical" }
  ))
    if (frame.kind === "canonical") events.push(frame.event);
  assert.equal(events.filter((event) => event.type === "run.failed").length, 1);
  return events.find((event) => event.type === "run.failed");
}

for (const [name, create] of [
  ["codex", createCodexAdapter],
  ["claude-code", createClaudeCodeAdapter]
]) {
  test(`${name}: missing cwd reports the directory problem instead of requesting CLI installation`, async () => {
    const cwd = join("/tmp", `octo-missing-${randomUUID()}`);
    const event = await failed(create({ command: process.execPath }), cwd);
    assert.match(event.payload.message, /工作目录不存在/);
    assert.ok(event.payload.message.includes(cwd));
    assert.match(event.payload.message, /ENOENT/);
    assert.equal(event.payload.failure.action.type, "contact_admin");
    assert.notEqual(event.payload.failure.code, "OH-ADP-3002");
    assert.equal(event.payload.error.code, "ENOENT");
  });
  test(`${name}: missing command in an existing cwd keeps the actual spawn error`, async () => {
    const command = join("/tmp", `octo-no-command-${randomUUID()}`);
    const event = await failed(create({ command }));
    assert.match(event.payload.message, /ENOENT/);
    assert.ok(event.payload.message.includes(command));
    assert.equal(event.payload.failure.code, "OH-ADP-3002");
  });
}

test("all Adapters preserve the same canonical failure detail and structured error through Host and card projection", async () => {
  const detail = "Selected model cannot be used with this account. Select another model.";
  for (const type of ["codex", "claude-code", "custom-provider"]) {
    const error = { code: "MODEL_ACCOUNT_RESTRICTION", message: detail, extra: { region: "test" } };
    const event = await failed({
      metadata: {
        type,

        agentSources: ["provisioned"],
        protocolSupport: { protocol: `${type}.canonical`, modes: ["canonical"], nativeMethods: [] }
      },
      async *invoke() {
        yield { protocolVersion: 2, type: "run.failed", payload: { message: detail, error } };
      }
    });
    assert.equal(event.payload.message, detail);
    assert.deepEqual(event.payload.error, error);
    const projector = new ImRunProjector("failed-run");
    projector.accept(event);
    const frame = buildReasoningFrame(projector.snapshot(), {
      ref: { id: "ai.reasoning-process", version: "0.4.0" },
      maxPayloadBytes: 16384
    });
    assert.equal(frame.errorTitle, "执行失败");
    assert.ok(frame.errorMessage.startsWith(detail.slice(0, 40)));
    assert.ok(frame.phases.at(-1).thought.startsWith(detail));
    assert.match(frame.phases.at(-1).thought, /MODEL_ACCOUNT_RESTRICTION/);
    assert.match(projector.snapshot().failureDetail, /"region": "test"/);
    assert.ok(frame.phases.at(-1).actions[0].detail.includes(event.payload.failure.diagnosticId));
    assert.match(frame.errorMessage, new RegExp(event.payload.failure.code));
    assert.match(frame.errorMessage, new RegExp(event.payload.failure.diagnosticId));
    assert.match(projector.finalReply.text, new RegExp(event.payload.failure.code));
    assert.match(projector.finalReply.text, new RegExp(event.payload.failure.diagnosticId));
  }
});

test("Codex turn error objects and Claude result errors are retained", () => {
  const error = {
    message: "Model is not available for this account",
    codexErrorInfo: "model_not_found",
    additionalDetails: "Choose another model"
  };
  const codex = new CodexEventNormalizer().normalize({
    method: "turn/completed",
    params: { turn: { status: "failed", error } }
  });
  assert.deepEqual(codex.find((event) => event.type === "run.failed").payload.error, error);
  const claude = new ClaudeEventNormalizer().normalize({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Invalid API key", "Please run /login"]
  });
  const payload = claude.find((event) => event.type === "run.failed").payload;
  assert.equal(payload.message, "Invalid API key\nPlease run /login");
  assert.deepEqual(payload.error.errors, ["Invalid API key", "Please run /login"]);
});

test("failure display retains useful reasons while redacting credentials", () => {
  const detail =
    'Invalid API key: api_key="private-key"; Authorization: Bearer secret-token; bf_private';
  const safe = sanitizePublicValue(detail);
  assert.match(safe, /Invalid API key/);
  assert.doesNotMatch(safe, /private-key|secret-token|bf_private/);
});
