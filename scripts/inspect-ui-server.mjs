import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemonServer } from "@mininglamp-oss/octo-harness-daemon-app";
import { callDaemon } from "../apps/cli/dist/main.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "octo-inspect-ui-"));
const socketPath = join(home, "daemon.sock");
const app = await startDaemonServer({
  socketPath,
  storePath: join(home, "state.db"),
  manifestPath: join(root, "test/fixtures/adapters.json"),
  hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
});
const adapters = ["codebuddy", "claude_worker", "codex"];
const stages = ["adapter.native", "adapter.canonical", "host.canonical", "runtime.dispatch"];
const directions = ["outbound", "inbound"];
for (let index = 0; index < 116; index++) {
  const isError = index === 112;
  const isWarning = index === 108;
  app.events.publish({
    source: index % 3 === 0 ? "provider-native" : index % 3 === 1 ? "adapter-canonical" : "host-canonical",
    stage: stages[index % stages.length],
    direction: directions[index % directions.length],
    type: isError ? "invocation.failed" : isWarning ? "transport.retry" : index % 4 === 0 ? "message.delta" : "agent_run.updated",
    profile: "online-test",
    runId: `run-recent-${String(index).padStart(3, "0")}`,
    invocationId: `inv-${String(index).padStart(4, "0")}`,
    adapterType: adapters[index % adapters.length],
    payload: {
      agent_session_id: `asess-${String(Math.floor(index / 4)).padStart(4, "0")}`,
      duration_ms: isError ? 1_684 : 28 + (index % 12) * 41,
      status: isError ? "failed" : isWarning ? "warning" : "ok",
      message: isError
        ? "Provider invocation failed while reading the response stream"
        : isWarning
          ? "Transport retry scheduled after a transient timeout"
          : `Run ${index} emitted a recent event`
    }
  });
}
const result = await callDaemon(socketPath, { method: "inspect.info" });
process.stdout.write(`${result.url}\n`);

let liveIndex = 116;
const liveTimer = setInterval(() => {
  const index = liveIndex++;
  app.events.publish({
    source: index % 2 === 0 ? "provider-native" : "adapter-canonical",
    stage: stages[index % stages.length],
    direction: directions[index % directions.length],
    type: index % 7 === 0 ? "tool_call.completed" : "message.delta",
    profile: "online-test",
    runId: `run-live-${String(Math.floor(index / 6)).padStart(3, "0")}`,
    invocationId: `inv-${String(index).padStart(4, "0")}`,
    adapterType: adapters[index % adapters.length],
    payload: {
      agent_session_id: `asess-live-${String(Math.floor(index / 12)).padStart(3, "0")}`,
      duration_ms: 18 + (index % 9) * 37,
      status: "ok",
      message: `Streaming frame ${index} received from the local daemon`
    }
  });
}, 320);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  clearInterval(liveTimer);
  await app.close();
  await rm(home, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
