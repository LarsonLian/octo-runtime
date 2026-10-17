import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon-app";

const execute = promisify(execFile);

test("a broken IPC client closes only its connection and leaves the daemon ready", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-ipc-error-"));
  const socketPath = join(home, "sockets", "octo-runtime-daemon.sock");
  const app = await startDaemonServer({
    socketPath,
    homePath: home,
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "packages/octo-runtime-adapter-host/dist/runner.js")
  });
  const accepted = new Promise((resolve) => app.server.once("connection", resolve));
  const client = net.createConnection(socketPath);
  client.on("error", () => client.destroy());
  try {
    const connection = await accepted;
    const closed = new Promise((resolve) => connection.once("close", resolve));
    assert.doesNotThrow(() =>
      connection.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
    );
    await closed;
    const status = JSON.parse(
      (
        await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
          cwd: root,
          env: { ...process.env, OCTO_RUNTIME_HOME: home }
        })
      ).stdout
    );
    assert.equal(status.ready, true);
  } finally {
    client.destroy();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});
