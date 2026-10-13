import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../packages/octo-harness-core/dist/index.js";

test("local steps are memory-only by default and persisted only with the explicit diagnostic switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-step-switch-"));
  const file = join(directory, "core.db");
  try {
    const value = SqliteStore.open(file);
    const event = { runId: "run", seq: 1, type: "message.delta", payload: { text: "hello" }, protocolVersion: 2 };
    value.appendEvent(event);
    assert.equal(value.getEvents("run").length, 1);
    value.close();
    const db = new DatabaseSync(file);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='agent_run_events'").get().n, 0);
    db.close();
    const restarted = SqliteStore.open(file);
    assert.deepEqual(restarted.getEvents("run"), []);restarted.close();
    const diagnostics = SqliteStore.open(file, { recordRunEvents: true });
    diagnostics.appendEvent(event);diagnostics.close();
    const reopened = SqliteStore.open(file, { recordRunEvents: true });
    assert.equal(reopened.getEvents("run").length, 1);reopened.close();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
