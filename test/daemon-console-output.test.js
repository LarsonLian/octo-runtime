import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { formatDaemonConsoleRecord } from "../apps/daemon/dist/console-output.js";

function record(overrides = {}) {
  return {
    schema_version: 1,
    ts: "2026-09-10T12:34:56.789Z",
    level: "info",
    component: "daemon",
    scope: "daemon.lifecycle",
    event: "daemon.ready",
    message: "daemon ready",
    pid: 12345,
    process_instance_id: "proc-test",
    seq: 1,
    sensitivity: "operational",
    data: { pid: 12345 },
    ...overrides
  };
}

test("foreground console renders concise lifecycle status", () => {
  const line = formatDaemonConsoleRecord(record());

  assert.equal(stripVTControlCharacters(line), "✓ Daemon ready pid=12345");
});

test("foreground console ignores routine local control connections", () => {
  const line = formatDaemonConsoleRecord(record({
    scope: "transport.unix",
    event: "transport.connection.opened",
    message: "daemon control connection opened"
  }));

  assert.equal(line, undefined);
});

test("verbose foreground console includes structured operational context", () => {
  const line = formatDaemonConsoleRecord(record({
    scope: "transport.wss",
    event: "transport.connection.opened",
    message: "Agent Work WebSocket connection opened",
    data: { runtime_id: "runtime-test", reconnect_attempt: 2 }
  }), { verbose: true });
  const plain = stripVTControlCharacters(line);

  assert.match(plain, /12:34:56\.789 INFO/);
  assert.match(plain, /transport\.connection\.opened/);
  assert.match(plain, /runtime=runtime-test attempt=2/);
  assert.match(plain, /"runtime_id":"runtime-test"/);
});
