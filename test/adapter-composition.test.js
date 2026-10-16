import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { createDaemonRuntime, startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";
import { invocationInput, canonicalEvents } from "@mininglamp-oss/octo-runtime-protocol";
import { invokeRequest, waitFor } from "./runtime-fixture.js";

const entrypoint = fileURLToPath(new URL("./fixtures/direct-adapter-host.js", import.meta.url));

test("direct-import Host serves only its selected adapter without a manifest", async () => {
  const host = await spawnAdapterHost({ entrypoint });
  try {
    assert.deepEqual(host.adapters.map(item => item.type), ["test"]);
    assert.ok(host.adapters.every(item => !Object.hasOwn(item, "executionFeatures")));
    const events = [];
    for await (const event of canonicalEvents(host.client.invokeFrames(invocationInput(invokeRequest({ approvalMode: "full_access" }), "canonical", "test")))) events.push(event);
    assert.ok(events.some(event => event.type === "run.completed"));
    await assert.rejects(async () => {
      for await (const frame of host.client.invokeFrames(invocationInput(invokeRequest(), "canonical", "codex"))) void frame;
    }, /adapter.*codex|unknown adapter/i);
  } finally {
    await host.close();
  }
});

test("JSON loader discovers and executes an Adapter without feature metadata", async () => {
  const host = await spawnAdapterHost({
    entrypoint: fileURLToPath(new URL("../packages/octo-runtime-adapter-host/dist/runner.js", import.meta.url)),
    manifest: fileURLToPath(new URL("./fixtures/adapters.json", import.meta.url))
  });
  try {
    const adapters = await host.client.list();
    assert.deepEqual(adapters.map(item => item.type), ["test"]);
    for (const metadata of [...host.adapters, ...adapters]) {
      assert.equal(Object.hasOwn(metadata, "executionFeatures"), false);
      assert.equal(Object.hasOwn(metadata, "capabilities"), false);
      assert.deepEqual(metadata.agentSources, ["provisioned"]);
    }
    const events = [];
    for await (const event of canonicalEvents(host.client.invokeFrames(invocationInput(
      invokeRequest({ prompt: "featureless-loader", approvalMode: "full_access" }), "canonical", "test"
    )))) events.push(event);
    assert.ok(events.some(event => event.type === "message.delta" && event.payload.text === "Handled: featureless-loader"));
    assert.equal(events.at(-1).type, "run.completed");
  } finally {
    await host.close();
  }
});

test("independent Host selections support empty sets and reject duplicates before ready", async () => {
  const empty = await spawnAdapterHost({ entrypoint, env: { ...process.env, OCTO_TEST_HOST_SELECTION: "empty" } });
  try {
    assert.deepEqual(empty.adapters, []);
  } finally {
    await empty.close();
  }
  await assert.rejects(spawnAdapterHost({ entrypoint, env: { ...process.env, OCTO_TEST_HOST_SELECTION: "duplicate" } }), /duplicate|already registered/i);
});

test("SDK starts and restarts a product's direct-import entry without CLI JSON", async () => {
  const home = await mkdtemp("/tmp/octo-composition-");
  const runtime = createDaemonRuntime({ appId: "composition-test", home, distribution: { adapterHostEntrypoint: entrypoint } });
  try {
    for (let i = 0; i < 2; i++) {
      const health = await runtime.startAccount({ subject: { type: "user", id: "composition-test" }, tenants: [{ id: "tenant" }] });
      assert.equal(health.local.adapterHostReady, true);
      const adapters = await runtime.listAdapters();
      assert.deepEqual(adapters.map(item => item.type), ["test"]);
      assert.ok(adapters.every(item => !Object.hasOwn(item, "executionFeatures")));
      const events = [];
      for await (const event of runtime.invoke(invocationInput(invokeRequest({
        runId: `sdk-featureless-${i}`, prompt: "featureless-sdk", approvalMode: "full_access"
      }), "canonical", "test"))) events.push(event);
      assert.ok(events.some(event => event.type === "message.delta" && event.payload.text === "Handled: featureless-sdk"));
      assert.equal(events.at(-1).type, "run.completed");
      await runtime.stop("quit");
    }
  } finally {
    await runtime.stop("quit");
    await rm(home, { recursive: true, force: true });
  }
});

test("daemon recovers the same direct-import Host selection after a crash", async () => {
  const home = await mkdtemp("/tmp/octo-composition-crash-");
  const daemon = await startDaemonServer({ socketPath: `${home}/control.sock`, stateDirectory: home, hostEntrypoint: entrypoint, adapterHostRestartDelaysMs: [10] });
  try {
    const oldPid = daemon.hostProcess.child.pid;
    daemon.hostProcess.child.kill("SIGKILL");
    await waitFor(() => daemon.runtime.adapterHost.state === "ready" && daemon.hostProcess.child.pid !== oldPid, 5_000);
    assert.deepEqual((await daemon.hostProcess.client.list()).map(item => item.type), ["test"]);
  } finally {
    await daemon.close();
    await rm(home, { recursive: true, force: true });
  }
});
