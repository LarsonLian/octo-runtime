import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLogViewer } from "../apps/cli/dist/log-viewer.js";
import { selectViewerRecords, ViewerLogIndex } from "../apps/daemon/dist/log-viewer.js";

test("trace viewer is loopback-only and protects its read API with a fragment capability", async () => {
  const queries = [];
  const viewer = await startLogViewer({
    initialRunId: "run-42</script><script>globalThis.injected=true</script>",
    query: async options => {
      queries.push(options);
      return {
        selectedRunId: options.runId,
        runs: [{ runId: options.runId, status: "completed", sessionId: "session-1" }],
        records: [{ ts: "2026-01-02T03:04:05.000Z", event: "adapter.selected", run_id: options.runId }],
        events: [],
        cursor: "cursor-2",
        nextSeq: 3,
        hasMore: false
      };
    }
  });
  try {
    const viewerUrl = new URL(viewer.url);
    const capability = viewerUrl.hash.slice(1);
    viewerUrl.hash = "";
    const page = await fetch(viewerUrl);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const html = await page.text();
    assert.match(html, /Octo Harness Trace Viewer/);
    assert.match(html, /Sensitive trace/);
    assert.match(html, /Provider session/);
    assert.match(html, /provider_request_id/);
    assert.match(html, /Provider evidence capture failed/);
    assert.match(html, /Select an event to inspect its evidence/);
    assert.match(html, /MAX_CLIENT_EVENTS = 2000/);
    assert.match(html, /10 \* 60 \* 1000/);
    assert.doesNotMatch(html, /[\u3400-\u9fff]/);
    assert.doesNotMatch(html, /<\/script><script>globalThis\.injected/);
    assert.equal(html.includes(capability), false);

    const api = new URL("/api/traces?runId=run-42&after=cursor-1&fromSeq=3&limit=9000", viewerUrl);
    assert.equal((await fetch(api)).status, 401);
    assert.equal((await fetch(api, { method: "POST" })).status, 405);
    const response = await fetch(api, { headers: { Authorization: `Bearer ${capability}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      selectedRunId: "run-42",
      runs: [{ runId: "run-42", status: "completed", sessionId: "session-1" }],
      records: [{ ts: "2026-01-02T03:04:05.000Z", event: "adapter.selected", run_id: "run-42" }],
      events: [],
      cursor: "cursor-2",
      nextSeq: 3,
      hasMore: false
    });
    assert.deepEqual(queries, [{
      runId: "run-42",
      includeSensitive: false,
      limit: 1000,
      after: "cursor-1",
      fromSeq: 3
    }]);
  } finally {
    await viewer.close();
  }

  await assert.rejects(startLogViewer({ host: "0.0.0.0", query: async () => [] }), /loopback/);
});

test("Viewer joins explicit pre-Run WSS and ChatTurn evidence without pulling another Run", () => {
  const records = [
    record("transport.connection.opened", { connection_id: "conn-1", endpoint: "wss://gateway.example/ws" }),
    record("chat_turn.received", { connection_id: "conn-1", chat_turn_id: "turn-1" }),
    record("chat_turn.dispatch.accepted", { connection_id: "conn-1", chat_turn_id: "turn-1" }, "run-1"),
    record("adapter.invoke.started", { connection_id: "conn-1" }, "run-1"),
    record("transport.message.received", { connection_id: "conn-1", frame_type: "context.sync_result" }),
    record("adapter.invoke.started", { connection_id: "conn-1" }, "run-2"),
    record("transport.connection.opened", { connection_id: "conn-2" })
  ];

  const selected = selectViewerRecords(records, "run-1", "turn-1");
  assert.deepEqual(selected.map(item => item.event), [
    "transport.connection.opened",
    "chat_turn.received",
    "chat_turn.dispatch.accepted",
    "adapter.invoke.started"
  ]);
  assert.equal(selected.some(item => item.run_id === "run-2"), false);
  assert.equal(selected.some(item => item.data.connection_id === "conn-2"), false);
  assert.equal(selected[0].data.endpoint, "wss://gateway.example/ws");
});

test("Viewer cursor follows ingestion order when the wall clock moves backward", async () => {
  const root = await mkdtemp(join(tmpdir(), "octo-viewer-index-"));
  const day = join(root, "2026-01-02");
  const path = join(day, "daemon.jsonl");
  await mkdir(day, { recursive: true });
  await writeFile(path, `${JSON.stringify(record("first", {}, "run-1", "2026-01-02T03:04:05.000Z", 1))}\n`);
  try {
    const index = new ViewerLogIndex(root);
    await index.refresh(false);
    const firstPage = index.page(new Set(index.records(false)), undefined, 10, false);

    await appendFile(path, `${JSON.stringify(record("second", {}, "run-1", "2026-01-02T02:00:00.000Z", 2))}\n`);
    await index.refresh(false);
    const secondPage = index.page(new Set(index.records(false)), firstPage.cursor, 10, false);

    assert.deepEqual(secondPage.records.map(item => item.event), ["second"]);
    assert.equal(secondPage.reset, false);

    const restarted = new ViewerLogIndex(root);
    await restarted.refresh(false);
    const restartedPage = restarted.page(new Set(restarted.records(false)), firstPage.cursor, 10, false);
    assert.equal(restartedPage.reset, true);
    assert.deepEqual(restartedPage.records.map(item => item.event), ["second", "first"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function record(event, data, runId, ts = "2026-01-02T03:04:05.000Z", seq = 1) {
  return {
    schema_version: 1,
    ts,
    level: "info",
    component: "daemon",
    process_instance_id: "process-1",
    seq,
    scope: event.startsWith("transport.") ? "transport.wss" : "test",
    event,
    message: event,
    sensitivity: "public",
    ...(runId ? { run_id: runId } : {}),
    data
  };
}
