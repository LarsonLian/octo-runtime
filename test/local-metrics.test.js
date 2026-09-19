import test from "node:test";
import assert from "node:assert/strict";
import { renderLocalMetrics } from "../packages/octo-harness-daemon/dist/local-metrics.js";

test("local metrics expose bounded Runtime recovery and storage state", () => {
  const output = renderLocalMetrics({
    agentWork: {
      runtimes: [{
        profile: "work\"profile",
        connectionState: "online",
        connectionReason: "none",
        lastRecoveryDurationMs: 1250,
        lastRecoveryTrigger: "network_change",
        outboxOldestAgeMs: 2500,
        outboxPendingBytes: 4096,
        storeHealth: { state: "low_disk" },
        runtimeId: "runtime-high-cardinality"
      }]
    }
  });
  assert.match(output, /runtime_connection_state\{profile="work\\"profile",state="online",reason="none"\} 1/);
  assert.match(output, /runtime_recovery_seconds\{profile="work\\"profile",trigger="network_change",outcome="online"\} 1.25/);
  assert.match(output, /outbox_oldest_seconds\{profile="work\\"profile",kind="event"\} 2.5/);
  assert.match(output, /outbox_pending_bytes\{profile="work\\"profile",kind="event"\} 4096/);
  assert.match(output, /store_health\{profile="work\\"profile",state="low_disk"\} 1/);
  assert.doesNotMatch(output, /runtime-high-cardinality/);
});

test("local metrics normalize unknown states instead of creating labels", () => {
  const output = renderLocalMetrics({
    agentWork: { runtimes: [{ profile: "p", connectionState: "future-state", storeHealth: { state: "future-state" } }] }
  });
  assert.match(output, /state="unknown"/);
  assert.match(output, /store_health\{profile="p",state="migration_failed"\}/);
});
