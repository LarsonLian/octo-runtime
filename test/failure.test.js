import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalEvent,
  assertFailureEnvelope,
  classifyFailure,
  failurePayload
} from "../packages/octo-runtime-protocol/dist/index.js";

const source = { component: "octo-runtime", adapter: "fixture" };

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
    [
      Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
      "adapter",
      "OH-ADP-3002",
      "ENOENT"
    ],
    [
      Object.assign(new Error("spawn failed"), { code: "EPERM" }),
      "adapter",
      "OH-ADP-3003",
      "EPERM"
    ],
    [
      Object.assign(new Error("spawn failed"), { code: "EACCES" }),
      "adapter",
      "OH-ADP-3003",
      "EACCES"
    ],
    [{ code: "ADAPTER_INVOCATION_FAILED" }, "adapter", "OH-ADP-3004", "ADAPTER_INVOCATION_FAILED"],
    [{ code: "INVALID_JSON" }, "adapter", "OH-ADP-3005", "ADAPTER_PROTOCOL_ERROR"],
    [{ code: "RPC_TIMEOUT" }, "adapter", "OH-ADP-3013", "RPC_TIMEOUT"],
    [
      { code: "CODEX_FINALIZATION_TIMEOUT" },
      "adapter",
      "OH-ADP-3013",
      "CODEX_FINALIZATION_TIMEOUT"
    ],
    [{ code: "HOST_FRAME_TOO_LARGE" }, "adapter", "OH-ADP-3014", "HOST_FRAME_TOO_LARGE"],
    [
      { code: "PROVIDER_MESSAGE_TOO_LARGE" },
      "provider",
      "OH-PRV-4009",
      "PROVIDER_MESSAGE_TOO_LARGE"
    ],
    [
      { code: "STREAM_QUEUE_BYTES_EXCEEDED" },
      "runtime",
      "OH-RUN-2009",
      "STREAM_QUEUE_BYTES_EXCEEDED"
    ]
  ];
  for (const [input, domain, code, reasonCode] of cases) {
    const failure = classify(
      input,
      domain,
      domain === "runtime" ? "runtime.command.accept" : "adapter.invoke"
    );
    assert.equal(failure.code, code);
    assert.equal(failure.reasonCode, reasonCode);
  }
});

test("Codex finalization timeout cannot retry an already answered turn", () => {
  const failure = classifyFailure(
    { code: "CODEX_FINALIZATION_TIMEOUT" },
    {
      defaultDomain: "adapter",
      stage: "adapter.invoke",
      source: { component: "octo-runtime", adapter: "codex" }
    }
  );
  assert.equal(failure.retryable, false);
  assert.equal(
    failure.params.configParameter,
    "execution_profile.agent_config.providerOptions.finalizationTimeoutMs"
  );
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
    const context = {
      defaultDomain: "adapter",
      stage: "adapter.invoke",
      source: { component: "octo-runtime", adapter: "codex" }
    };
    const payload = failurePayload(
      {
        code,
        timeoutMs: 3600000,
        timeoutStage: "run_deadline",
        timeoutReason: "run_deadline",
        watchdog: { elapsedMs: 3600000, secret: "private", openToolCount: 1 }
      },
      context
    );
    assert.equal(payload.failure.code, `OH-ADP-${suffix}`);
    assert.equal(payload.failure.params.configParameter, `execution_profile.${parameter}`);
    assert.doesNotMatch(JSON.stringify(payload), /private|secret/);
    assert.doesNotThrow(() =>
      assertCanonicalEvent({ protocolVersion: 2, type: "run.failed", payload })
    );
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
  const payload = failurePayload(
    {
      code: "invalid_api_key",
      message: "Bearer top-secret-token",
      providerError: { request: { headers: { authorization: "Bearer top-secret-token" } } },
      adapterType: "codex"
    },
    {
      defaultDomain: "provider",
      stage: "provider.invoke",
      source,
      diagnosticId: "diag_0123456789abcdef0123456789abcdef",
      occurredAt: "2026-09-18T06:37:29.129Z"
    }
  );

  assert.equal(payload.code, "invalid_api_key");
  assert.equal(payload.failure.code, "OH-PRV-4001");
  assert.equal(payload.failure.messageKey, "error.provider.credentials_invalid");
  assert.equal(payload.adapterType, "codex");
  assert.doesNotMatch(JSON.stringify(payload), /top-secret-token|authorization|providerError/);
  assert.doesNotThrow(() =>
    assertCanonicalEvent({ protocolVersion: 2, type: "run.failed", payload })
  );
});

test("configuration timeout field names do not imply a timeout", () => {
  const messages = [
    'Error parsing config: invalid type: string "", expected u64 in mcp_servers.node_repl.tool_timeout_sec',
    "invalid value for mcp_servers.local.startup_timeout_sec",
    "APPROVAL_TIMEOUT_INVALID",
    "invalid model_idle_timeout_ms and appServerRequestTimeoutMs"
  ];
  for (const message of messages) {
    assert.equal(classify(new Error(message), "adapter").code, "OH-ADP-3004", message);
    assert.equal(classify(new Error(message), "provider").code, "OH-PRV-4099", message);
  }
});

test("explicit errors and bounded timeout expressions retain their classifications", () => {
  const inputs = [
    { code: "ETIMEDOUT", message: "request failed" },
    new Error("upstream timed out after 30000ms"),
    new Error("request timeout after 30000ms"),
    Object.assign(new Error("operation interrupted"), { name: "TimeoutError" }),
    new Error("APPROVAL_CLEANUP_TIMEOUT"),
    { code: "ERR_SOCKET_TIMEOUT", message: "request failed" },
    new Error("request failed", {
      cause: Object.assign(new Error("connection failed"), { code: "ETIMEDOUT" })
    }),
    { message: "tool_timeout_sec is configured, but the request timed out" }
  ];
  for (const input of inputs) {
    assert.equal(classify(input, "adapter").code, "OH-ADP-3006");
    assert.equal(classify(input, "provider").code, "OH-PRV-4006");
  }
  for (const input of [{ code: "ECONNRESET" }, new Error("read ECONNRESET")])
    assert.equal(classify(input, "provider").reasonCode, "PROVIDER_TIMEOUT");
  assert.equal(
    classify({ code: "RPC_TIMEOUT", message: "invalid tool_timeout_sec" }, "adapter").code,
    "OH-ADP-3013"
  );
});

test("provider HTTP and protocol errors retain priority over generic timeout evidence", () => {
  for (const [status, code] of [
    [401, "OH-PRV-4001"],
    [403, "OH-PRV-4002"],
    [404, "OH-PRV-4003"],
    [429, "OH-PRV-4005"],
    [503, "OH-PRV-4006"]
  ]) {
    for (const message of ["invalid tool_timeout_sec", "upstream timed out"])
      assert.equal(classify({ status, message }, "provider").code, code);
  }
  assert.equal(
    classify({ code: "INVALID_JSON", message: "upstream timed out" }, "adapter").code,
    "OH-ADP-3005"
  );
  assert.equal(
    classify({ code: "ADAPTER_MODEL_IDLE_TIMEOUT", message: "invalid tool_timeout_sec" }, "adapter")
      .code,
    "OH-ADP-3008"
  );
});

test("configuration parsing diagnostics do not enter public failure messages", () => {
  const payload = failurePayload(
    new Error("invalid tool_timeout_sec in config: Authorization: Bearer private-token"),
    {
      defaultDomain: "adapter",
      stage: "adapter.invoke",
      source
    }
  );
  assert.equal(payload.failure.code, "OH-ADP-3004");
  assert.doesNotMatch(JSON.stringify(payload), /private-token|Authorization|tool_timeout_sec/);
});

test("Agent Run UUID deterministically owns the diagnostic UUID", () => {
  const runId = "run_35c4ffc5db9940c9be7ce3a894819ae3";
  const classified = classifyFailure(
    { code: "RPC_TIMEOUT" },
    {
      defaultDomain: "adapter",
      stage: "adapter.invoke",
      source,
      runId,
      diagnosticId: "diag_0123456789abcdef0123456789abcdef"
    }
  );
  assert.equal(classified.diagnosticId, "diag_35c4ffc5db9940c9be7ce3a894819ae3");

  const payload = failurePayload(
    {
      code: "PROVIDER_ERROR",
      failure: classify({ status: 503 })
    },
    {
      defaultDomain: "provider",
      stage: "provider.invoke",
      source,
      runId,
      preserveExisting: true
    }
  );
  assert.equal(payload.failure.diagnosticId, "diag_35c4ffc5db9940c9be7ce3a894819ae3");
});

test("invalid structured failures are rejected at the adapter boundary", () => {
  assert.throws(
    () =>
      assertCanonicalEvent({
        protocolVersion: 2,
        type: "run.failed",
        payload: {
          failure: {
            schemaVersion: 1,
            code: "OH-PRV-4001",
            reasonCode: "PROVIDER_HTTP_401"
          }
        }
      }),
    /failure\.category/
  );
});

test("shared failure schema accepts Worker-owned offline failures", () => {
  const failure = {
    ...classify({ code: "RUNTIME_DRAINING" }, "runtime", "runtime.command.accept"),
    source: { component: "octo-agent-worker" }
  };
  assert.doesNotThrow(() => assertFailureEnvelope(failure));
});
