import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticBundle } from "../packages/octo-harness-daemon/dist/diagnostic-bundle.js";

test("diagnostic bundle exports only allowlisted metadata", () => {
  const bundle = createDiagnosticBundle({
    ready: true,
    storePath: "/secret/state.db",
    agentWork: {
      connected: false,
      runtimes: [{
        runtimeKey: "runtime-1",
        connectionState: "backing_off",
        outboxPending: 12,
        outboxPendingBytes: 4096,
        token: "runtime-secret",
        storeHealth: { state: "healthy", acceptingNewRuns: true }
      }]
    }
  }, [{
    ts: "2026-09-20T12:00:00.000Z",
    level: "warn",
    scope: "runtime.connection",
    event: "runtime.reconnect.scheduled",
    message: "contains prompt-secret",
    data: {
      reconnect_attempt: 3,
      error_code: "NETWORK_UNAVAILABLE",
      prompt: "prompt-secret",
      model_output: "model-secret",
      tool_input: "tool-input-secret",
      tool_output: "tool-output-secret",
      payload_json: "outbox-secret",
      token: "runtime-secret"
    }
  }], new Date("2026-09-20T12:01:00.000Z"));

  assert.equal(bundle.dataClass, "metadata_only");
  assert.equal(bundle.generatedAt, "2026-09-20T12:01:00.000Z");
  assert.equal(bundle.status.agentWork.runtimes[0].outboxPending, 12);
  assert.equal(bundle.timeline[0].data.reconnect_attempt, 3);
  assert.equal(bundle.timeline[0].data.error_code, "NETWORK_UNAVAILABLE");
  const encoded = JSON.stringify(bundle);
  for (const forbidden of [
    "/secret/state.db", "runtime-secret", "prompt-secret", "model-secret",
    "tool-input-secret", "tool-output-secret", "outbox-secret"
  ]) assert.doesNotMatch(encoded, new RegExp(forbidden.replaceAll("/", "\\/")));
});

test("diagnostic bundle excludes newly introduced fields by default", () => {
  const bundle = createDiagnosticBundle(
    { ready: true, futureSensitiveField: "must-not-export" },
    [{ ts: "2026-09-20T12:00:00.000Z", event: "future", futureSensitiveField: "must-not-export" }]
  );
  assert.doesNotMatch(JSON.stringify(bundle), /must-not-export/);
});
