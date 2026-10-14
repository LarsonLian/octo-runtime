import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";
import { createImModule } from "@mininglamp-oss/octo-runtime-channel-im/daemon-module";
import { callDaemon } from "../apps/cli/dist/main.js";
import { invokeRequest, waitFor } from "./agent-work-runtime-fixture.js";

const root = fileURLToPath(new URL("..", import.meta.url));
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.filter(entry => entry.name !== "node_modules").map(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]
  ))).flat();
}

test("Runtime source and built packages do not load a SQL driver or expose a domain store", async () => {
  for (const directory of ["apps", "packages"]) {
    for (const path of await files(join(root, directory))) {
      if (!/\.(?:js|ts)$/.test(path)) continue;
      assert.doesNotMatch(await readFile(path, "utf8"), /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:node:sqlite|better-sqlite3|sqlite3)["']/, path);
    }
  }
  const core = await import("@mininglamp-oss/octo-runtime-core");
  assert.deepEqual(Object.keys(core).sort(), ["localRuntimeLimits", "resolveLocalContext"]);
});

test("daemon executes with IM enabled without databases and does not recover old Runs", async t => {
  const home = await mkdtemp(join(tmpdir(), "octo-stateless-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = {
    homePath: home,
    socketPath: join(home, "sockets", "daemon.sock"),
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "apps/adapter-host/dist/index.js"),
    modules: [{ id: "channel-im", create: createImModule, config: { bots: [] } }]
  };
  let app = await startDaemonServer(options);
  try {
    const request = invokeRequest({ approvalMode: "full_access" });
    await app.host.submit("test", request, { protocolMode: "canonical" });
    await waitFor(() => app.host.get(request.runId).terminal);
    assert.equal(app.host.get(request.runId).terminal.control.state, "completed");
    const status = await callDaemon(options.socketPath, { method: "status" });
    assert.equal(status.storePath, undefined);
    for (const method of ["agent_session.list", "agent_run.list", "agent_run.wait"])
      await assert.rejects(callDaemon(options.socketPath, { method }), /unknown daemon method/);
    assert.ok((await files(home)).every(path => !/\.(?:db|sqlite)(?:-wal|-shm)?$/.test(path)));
    await app.close();
    app = await startDaemonServer(options);
    assert.throws(() => app.host.get(request.runId), /RUN_NOT_AVAILABLE/);
    assert.equal(app.host.status.activeRuns, 0);
  } finally { await app.close(); }
});
