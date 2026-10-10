import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalEvent,
  assertFailureEnvelope,
  classifyFailure,
  failurePayload
} from "../packages/octo-harness-protocol/dist/index.js";

const source = { component: "octo-harness", adapter: "fixture" };

function classify(input, defaultDomain = "provider", stage = "provider.invoke") {
  return classifyFailure(input, {
    defaultDomain,
    stage,
    source,
    diagnosticId: "diag_0123456789abcdef0123456789abcdef",
    occurredAt: "2026-09-18T06:37:29.129Z"
  });
}

test("global failure classifier covers runtime admission and adapter roots", () => {
  const cases = [
    [{ code: "RUNTIME_DRAINING" }, "runtime", "OH-RUN-2002", "RUNTIME_DRAINING"],
    [{ code: "OUTBOX_HARD_LIMIT" }, "runtime", "OH-RUN-2003", "OUTBOX_HARD_LIMIT"],
    [{ code: "LOCAL_STORE_FULL" }, "runtime", "OH-RUN-2008", "LOCAL_STORE_FULL"],
    [Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "adapter", "OH-ADP-3002", "ENOENT"],
    [Object.assign(new Error("spawn failed"), { code: "EPERM" }), "adapter", "OH-ADP-3003", "EPERM"],
    [Object.assign(new Error("spawn failed"), { code: "EACCES" }), "adapter", "OH-ADP-3003", "EACCES"],
    [{ code: "ADAPTER_INVOCATION_FAILED" }, "adapter", "OH-ADP-3004", "ADAPTER_INVOCATION_FAILED"],
    [{ code: "INVALID_JSON" }, "adapter", "OH-ADP-3005", "ADAPTER_PROTOCOL_ERROR"],
    [{ code: "RPC_TIMEOUT" }, "adapter", "OH-ADP-3013", "RPC_TIMEOUT"],
    [{ code: "CODEX_FINALIZATION_TIMEOUT" }, "adapter", "OH-ADP-3013", "CODEX_FINALIZATION_TIMEOUT"]
  ];
  for (const [input, domain, code, reasonCode] of cases) {
    const failure = classify(input, domain, domain === "runtime" ? "runtime.command.accept" : "adapter.invoke");
    assert.equal(failure.code, code);
    assert.equal(failure.reasonCode, reasonCode);
  }
});

test("Codex finalization timeout cannot retry an already answered turn", () => {
  const failure = classifyFailure({ code: "CODEX_FINALIZATION_TIMEOUT" }, {
    defaultDomain: "adapter", stage: "adapter.invoke", source: { component: "octo-harness", adapter: "codex" }
  });
  assert.equal(failure.retryable, false);
  assert.equal(failure.params.configParameter, "execution_profile.agent_config.providerOptions.finalizationTimeoutMs");
});

test("timeout causes have distinct public codes and actionable configuration paths", () => {
  const cases = [
    ["ADAPTER_FIRST_FRAME_TIMEOUT", "3007", "runtime_limits.first_frame_timeout_ms"],
    ["ADAPTER_MODEL_IDLE_TIMEOUT", "3008", "runtime_limits.model_idle_timeout_ms"],
    ["ADAPTER_TOOL_IDLE_TIMEOUT", "3009", "runtime_limits.tool_timeout_ms"],
    ["ADAPTER_TOOL_DEADLINE", "3010", "runtime_limits.tool_wall_timeout_ms"],
    ["ADAPTER_RUN_DEADLINE", "3011", "runtime_limits.run_timeout_ms"],
    ["ADAPTER_CLEANUP_TIMEOUT", "3012", "runtime_limits.cancel_grace_ms"],
    ["RPC_TIMEOUT", "3013", "agent_config.providerOptions.appServerRequestTimeoutMs"]
  ];
  for (const [code, suffix, parameter] of cases) {
    const context = { defaultDomain: "adapter", stage: "adapter.invoke", source: { component: "octo-harness", adapter: "codex" } };
    const payload = failurePayload({ code, timeoutMs: 3600000, timeoutStage: "run_deadline", timeoutReason: "run_deadline", watchdog: { elapsedMs: 3600000, secret: "private", openToolCount: 1 } }, context);
    assert.equal(payload.failure.code, `OH-ADP-${suffix}`);
    assert.equal(payload.failure.params.configParameter, `execution_profile.${parameter}`);
    assert.doesNotMatch(JSON.stringify(payload), /private|secret/);
    assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "run.failed", payload }));
    assert.deepEqual(failurePayload(payload, context).failure.params, payload.failure.params);
    assert.equal(payload.failure.params.elapsedMs, 3600000);
  }
  assert.equal(classify({ code: "ADAPTER_TIMEOUT" }, "adapter").code, "OH-ADP-3006");
});

test("global failure classifier distinguishes provider authentication, quota, rate and availability", () => {
  const cases = [
    [{ status: 401 }, "OH-PRV-4001"],
    [{ statusCode: 403 }, "OH-PRV-4002"],
    [{ status: 404 }, "OH-PRV-4003"],
    [{ code: "model_not_found" }, "OH-PRV-4003"],
    [{ status: 429, message: "insufficient_quota" }, "OH-PRV-4004"],
    [{ status: 429 }, "OH-PRV-4005"],
    [{ status: 503 }, "OH-PRV-4006"],
    [{ message: "upstream timed out" }, "OH-PRV-4006"],
    [{ code: "official_clients_only" }, "OH-PRV-4007"],
    [{ code: "PROVIDER_CONFIG_MISSING" }, "OH-PRV-4008"],
    [{ message: "new provider failure" }, "OH-PRV-4099"]
  ];
  for (const [input, code] of cases) assert.equal(classify(input).code, code);
});

test("failure payload is backwards compatible and excludes untrusted secrets", () => {
  const payload = failurePayload({
    code: "invalid_api_key",
    message: "Bearer top-secret-token",
    providerError: { request: { headers: { authorization: "Bearer top-secret-token" } } },
    adapterType: "codex"
  }, {
    defaultDomain: "provider",
    stage: "provider.invoke",
    source,
    diagnosticId: "diag_0123456789abcdef0123456789abcdef",
    occurredAt: "2026-09-18T06:37:29.129Z"
  });

  assert.equal(payload.code, "invalid_api_key");
  assert.equal(payload.failure.code, "OH-PRV-4001");
  assert.equal(payload.failure.messageKey, "error.provider.credentials_invalid");
  assert.equal(payload.adapterType, "codex");
  assert.doesNotMatch(JSON.stringify(payload), /top-secret-token|authorization|providerError/);
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "run.failed", payload }));
});

test("Agent Run UUID deterministically owns the diagnostic UUID", () => {
  const runKey = "arun_35c4ffc5db9940c9be7ce3a894819ae3";
  const classified = classifyFailure({ code: "RPC_TIMEOUT" }, {
    defaultDomain: "adapter",
    stage: "adapter.invoke",
    source,
    runKey,
    diagnosticId: "diag_0123456789abcdef0123456789abcdef"
  });
  assert.equal(classified.diagnosticId, "diag_35c4ffc5db9940c9be7ce3a894819ae3");

  const payload = failurePayload({
    code: "PROVIDER_ERROR",
    failure: classify({ status: 503 })
  }, {
    defaultDomain: "provider",
    stage: "provider.invoke",
    source,
    runKey,
    preserveExisting: true
  });
  assert.equal(payload.failure.diagnosticId, "diag_35c4ffc5db9940c9be7ce3a894819ae3");
});

test("invalid structured failures are rejected at the adapter boundary", () => {
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2,
    type: "run.failed",
    payload: {
      failure: {
        schemaVersion: 1,
        code: "OH-PRV-4001",
        reasonCode: "PROVIDER_HTTP_401"
      }
    }
  }), /failure\.category/);
});

test("shared failure schema accepts Worker-owned offline failures", () => {
  const failure = {
    ...classify({ code: "RUNTIME_DRAINING" }, "runtime", "runtime.command.accept"),
    source: { component: "octo-agent-worker" }
  };
  assert.doesNotThrow(() => assertFailureEnvelope(failure));
});
