import test from "node:test";
import assert from "node:assert/strict";
import { WatchdogMetrics } from "../packages/octo-harness-adapter-host/dist/watchdog-metrics.js";
import { renderLocalMetrics } from "../packages/octo-harness-daemon/dist/local-metrics.js";

test("watchdog snapshots preserve counters without high cardinality or censored success samples", () => {
  const metrics = new WatchdogMetrics();
  for (let i = 0; i < 100; i++) {
    const data = { modelIdlePolicy: "observe", runKey: `secret-run-${i}` };
    metrics.record(`private-adapter-${i}`, { event: "started", data });
    metrics.record(`private-adapter-${i}`, { event: "timeout", data: { ...data, timeoutReason: "run_deadline" } });
    metrics.record(`private-adapter-${i}`, { event: "finished", data: { ...data, outcome: "failed", maxCanonicalGapMs: 125000, maxProgressGapMs: 5000 } });
  }
  const series = metrics.snapshot();
  assert.ok(series.length < 30);
  assert.equal(series.find(x => x.name === "active").value, 0);
  assert.equal(series.find(x => x.name === "timeouts_total").value, 100);
  const status = { watchdogMetrics: { capturedAt: Date.now(), series } };
  const text = renderLocalMetrics(status);
  assert.match(text, /timeouts_total\{adapter="other",policy="observe",reason="run_deadline"\} 100/);
  assert.match(text, /outcome="failed",kind="canonical",le="120"\} 0/);
  assert.match(text, /outcome="failed",kind="canonical",le="300"\} 100/);
  assert.doesNotMatch(text, /secret|private|outcome="completed"/);
  assert.deepEqual(metrics.snapshot(), series);
  status.watchdogMetrics.series.push({ name: "active", labels: { runKey: "secret" }, value: 1 });
  assert.doesNotMatch(renderLocalMetrics(status), /secret|runKey/);
});
