import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { invokeRequest } from "../test/agent-work-runtime-fixture.js";

const sdk = resolve(process.argv[2]);
const packages = await readdir(join(sdk, "node_modules/.pnpm"));
assert.equal(
  packages.some((name) => /octo-harness-(worker-access|channel-im|embedded)/.test(name)),
  false
);
// Import the deployed SDK, so Node cannot resolve workspace-only dependencies.
const deployed = await import(pathToFileURL(join(sdk, "dist/index.js")).href);
assert.equal(typeof deployed.createDaemonRuntime, "function");
const home = await mkdtemp("/tmp/daemon-customer-");
const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = deployed.createDaemonRuntime({
  appId: "eva-customer-proof",
  home,
  development: true,
  distribution: { manifestPath: join(root, "test/fixtures/adapters.json") },
  modules: [
    {
      id: "worker-access",
      module: join(sdk, "missing-worker-access.js"),
      exportName: "createWorkerAccessModule"
    }
  ]
});
async function execute(runId) {
  const request = invokeRequest({
    runId,
    invocationId: runId,
    approvalMode: "full_access",
    runMetadata: { runtimeId: runtime.health().profiles[0].runtimeId }
  });
  const events = [];
  for await (const event of runtime.invoke("test", request, { protocolMode: "canonical" }))
    events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
}
try {
  const input = { subject: { type: "user", id: "eva-user" }, tenants: [{ id: "eva-tenant" }] };
  const ready = await runtime.startAccount(input);
  assert.equal(ready.local.ready, true);
  assert.equal(ready.modules["worker-access"].phase, "disabled");
  await execute("customer-local");
  await runtime.startModule("worker-access", {});
  await assert.rejects(runtime.requestModule("worker-access", "status"), /Cannot find module/);
  const afterFailure = await runtime.startAccount(input);
  assert.equal(afterFailure.local.ready, true);
  assert.equal(afterFailure.phase, "running");
  assert.equal(afterFailure.modules["worker-access"].phase, "error");
  await execute("customer-after-cloud-failure");
  await runtime.stopModule("worker-access");
  await execute("customer-after-module-stop");
  console.log(
    JSON.stringify({
      deployedSdk: sdk,
      workerAccessAbsent: true,
      channelImAbsent: true,
      localExecutions: 3,
      missingModuleIsolated: true
    })
  );
} finally {
  await runtime.stop("quit");
  await rm(home, { recursive: true, force: true });
}
