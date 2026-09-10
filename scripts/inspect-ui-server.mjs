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
app.events.publish({ source: "provider-native", type: "provider.output", runId: "run-demo", payload: { model: "test", bytes: 128 } });
app.events.publish({ source: "adapter-canonical", type: "tool_call.create", runId: "run-demo", payload: { name: "shell", status: "running" } });
app.events.publish({ source: "host-canonical", type: "message.delta", runId: "run-demo", payload: { channel: "analysis", text: "Inspecting the workspace" } });
const result = await callDaemon(socketPath, { method: "inspect.open" });
process.stdout.write(`${result.url}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await app.close();
  await rm(home, { recursive: true, force: true });
  process.exit(0);
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
