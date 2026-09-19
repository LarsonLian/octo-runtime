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
    [Object.assign(new Error("spawn failed"), { code: "ENOENT" }), "adapter", "OH-ADP-3002", "ENOENT"],
    [Object.assign(new Error("spawn failed"), { code: "EPERM" }), "adapter", "OH-ADP-3003", "EPERM"],
    [Object.assign(new Error("spawn failed"), { code: "EACCES" }), "adapter", "OH-ADP-3003", "EACCES"],
    [{ code: "ADAPTER_INVOCATION_FAILED" }, "adapter", "OH-ADP-3004", "ADAPTER_INVOCATION_FAILED"],
    [{ code: "INVALID_JSON" }, "adapter", "OH-ADP-3005", "ADAPTER_PROTOCOL_ERROR"],
    [{ code: "RPC_TIMEOUT" }, "adapter", "OH-ADP-3006", "ADAPTER_TIMEOUT"]
  ];
  for (const [input, domain, code, reasonCode] of cases) {
    const failure = classify(input, domain, domain === "runtime" ? "runtime.command.accept" : "adapter.invoke");
    assert.equal(failure.code, code);
    assert.equal(failure.reasonCode, reasonCode);
  }
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
  assert.doesNotThrow(() => assertCanonicalEvent({ type: "run.error", payload }));
});

test("invalid structured failures are rejected at the adapter boundary", () => {
  assert.throws(() => assertCanonicalEvent({
    type: "run.error",
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
