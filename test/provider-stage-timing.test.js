import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderStageTimer, measureProviderStage } from "../packages/octo-harness-adapter-sdk/dist/index.js";
import { LocalObservability, DEFAULT_OBSERVABILITY_CONFIGURATION } from "@mininglamp-oss/octo-harness-observability";

test("stage timings use a monotonic clock, record failures and finish only once", async (t) => {
  let now = 10;
  t.mock.method(performance, "now", () => now);
  const observations = [];
  const context = { observe: async value => { observations.push(value); return { state: "disabled" }; } };
  const finish = createProviderStageTimer(context)("first_output", "session/prompt");
  now = 135;
  finish();
  finish("failed");
  assert.equal(observations.length, 1);
  assert.equal(observations[0].data.duration_ms, 125);
  const failure = new Error("provider failed");
  await assert.rejects(measureProviderStage(context, "initialize", "initialize", async () => {
    now += 75;
    throw failure;
  }), error => error === failure);
  assert.equal(observations[1].data.duration_ms, 75);
  assert.equal(observations[1].data.outcome, "failed");
  await measureProviderStage({ observe: async () => { throw new Error("logger unavailable"); } }, "initialize", "initialize", async () => "ok");
});

test("stage durations persist as operational JSON with provider capture off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-stage-timing-"));
  const logger = new LocalObservability({ ...DEFAULT_OBSERVABILITY_CONFIGURATION, directory,
    component: "adapter-host", fileLog: true, logLevel: "info", captureProviderIo: "off" });
  try {
    await logger.observeProvider({ runId: "run-stage", invocationId: "inv-stage", agentSessionId: "session-stage", adapterType: "codebuddy" }, {
      event: "provider.stage.completed", rpcMethod: "initialize",
      data: { stage: "initialize", outcome: "completed", duration_ms: 125, prompt: "must-not-appear" }
    });
    await logger.flush();
    const records = await logger.query({ runId: "run-stage" });
    assert.equal(records.length, 1);
    assert.equal(records[0].event, "provider.stage.completed");
    assert.equal(records[0].duration_ms, 125);
    assert.equal(records[0].adapter_type, "codebuddy");
    assert.equal(records[0].sensitivity, "operational");
    assert.equal(records[0].data.stage, "initialize");
    assert.doesNotMatch(JSON.stringify(records), /must-not-appear/);
  } finally {
    await logger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
