import test from "node:test";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "../apps/inspect-web/node_modules/fflate/esm/index.mjs";
import { normalizeEvent } from "../apps/inspect-web/src/domain.ts";
import { createInspectBundle } from "../apps/inspect-web/src/export.ts";
import { compileQuery, queryCompletions } from "../apps/inspect-web/src/query.ts";

const record = {
  key: "event:1",
  durable: false,
  source: "provider-native",
  stage: "adapter.native",
  direction: "outbound",
  type: "provider.output",
  profile: "work",
  runtimeId: "runtime-work",
  sessionId: "session-456",
  runId: "run-123",
  invocationId: "invocation-789",
  adapterType: "codebuddy",
  durationMs: 142,
  status: "ok",
  localSeq: 1,
  occurredAt: "2026-09-14T00:00:00.000Z",
  summary: "done",
  bytes: 100,
  value: {}
};

test("inspect QL evaluates comparisons, precedence, and parentheses", () => {
  assert.equal(compileQuery("adapter_type=codebuddy").predicate(record), true);
  assert.equal(compileQuery("runtime_id=runtime-work").predicate(record), true);
  assert.equal(compileQuery("source!=daemon").predicate(record), true);
  assert.equal(compileQuery("stage=adapter.native and direction=outbound").predicate(record), true);
  assert.equal(compileQuery("session_id~=456 and status=ok").predicate(record), true);
  assert.equal(compileQuery("run_id~=123").predicate(record), true);
  assert.equal(
    compileQuery("profile=other or source=provider-native and type=provider.output").predicate(record),
    true
  );
  assert.equal(
    compileQuery("(profile=other or source=daemon) and adapter_type=codebuddy").predicate(record),
    false
  );
});

test("inspect event normalization extracts table fields without inventing diagnostics", () => {
  const value = {
    local_seq: 9,
    occurred_at: "2026-09-14T00:00:09.000Z",
    source: "adapter-rpc",
    stage: "adapter.native",
    direction: "daemon_to_host",
    type: "invocation.failed",
    profile: "work",
    runtime_id: "runtime-work",
    run_id: "run-9",
    agent_session_id: "session-9",
    invocation_id: "inv-9",
    agent_source: "provisioned", adapter_type: "codebuddy",
    payload: {
      duration_ms: 1684,
      status: "failed",
      message: "Provider stream failed"
    }
  };
  const normalized = normalizeEvent(value, JSON.stringify(value));
  assert.equal(normalized.direction, "inbound");
  assert.equal(normalized.runtimeId, "runtime-work");
  assert.equal(normalized.sessionId, "session-9");
  assert.equal(normalized.durationMs, 1684);
  assert.equal(normalized.status, "error");
});

test("inspect ZIP export contains ordered events and diagnostics", () => {
  const newer = { ...record, key: "event:2", localSeq: 2, value: { local_seq: 2 } };
  const older = { ...record, key: "event:1", localSeq: 1, value: { local_seq: 1 } };
  const archive = unzipSync(createInspectBundle([newer, older], { event_count: 2 }));
  assert.deepEqual(Object.keys(archive).sort(), ["diagnostics.json", "events.jsonl", "schema-manifest.json"]);
  assert.equal(strFromU8(archive["events.jsonl"]), '{"local_seq":1}\n{"local_seq":2}');
  assert.equal(JSON.parse(strFromU8(archive["diagnostics.json"])).event_count, 2);
  assert.equal(JSON.parse(strFromU8(archive["schema-manifest.json"])).order, "oldest_to_newest");
});

test("inspect QL returns useful syntax errors", () => {
  const unknown = compileQuery("adapter=codebuddy");
  assert.match(unknown.error?.message ?? "", /未知字段 adapter/);
  assert.equal(unknown.error?.offset, 0);

  const incomplete = compileQuery("adapter_type=");
  assert.match(incomplete.error?.message ?? "", /表达式不完整/);
});

test("inspect QL completes fields, operators, values, and logical operators", () => {
  const values = { agent_source: "provisioned", adapter_type: ["codex", "codebuddy"], runtime_id: ["runtime-work"] };
  assert.deepEqual(
    queryCompletions("adap", 4, values).map(item => item.label),
    ["adapter_type"]
  );
  assert.deepEqual(
    queryCompletions("adapter_type!", 13, values).map(item => item.label),
    ["!="]
  );
  assert.deepEqual(
    queryCompletions("adapter_type=codeb", 18, values).map(item => item.label),
    ["codebuddy"]
  );
  assert.deepEqual(
    queryCompletions("adapter_type=codebuddy ", 23, values).map(item => item.label),
    ["and", "or"]
  );
  assert.deepEqual(
    queryCompletions("runtime_id=runtime-w", 20, values).map(item => item.label),
    ["runtime-work"]
  );
});
