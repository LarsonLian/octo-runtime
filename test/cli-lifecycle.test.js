import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { runCli } from "../apps/cli/dist/main.js";
import { resolveDaemonRuntimePaths } from "../apps/daemon/dist/runtime-options.js";
import { startDaemonServer } from "@mininglamp-oss/octo-harness-daemon-app";
import { wire } from "./agent-work-runtime-fixture.js";

const root = fileURLToPath(new URL("..", import.meta.url));

class InMemoryServiceBackend {
  kind = "launchd-user";
  enabled = false;
  state = "not_installed";
  app;

  async probe() {
    return { supported: true, manager: this.kind, detail: "in-memory test manager" };
  }

  async inspect() {
    return {
      manager: this.kind,
      state: this.state,
      enabled: this.enabled,
      drift: [],
      ...(this.app ? { pid: process.pid } : {})
    };
  }

  async install(spec) {
    this.spec = spec;
    if (this.state === "not_installed") this.state = "stopped";
  }

  async uninstall() {
    await this.stop();
    this.state = "not_installed";
    this.enabled = false;
  }

  async enable() { this.enabled = true; }
  async disable() { this.enabled = false; }

  async start(spec = this.spec) {
    if (this.app) return;
    this.spec = spec;
    this.state = "starting";
    const homeIndex = spec.args.indexOf("--home");
    const home = spec.args[homeIndex + 1];
    this.app = await startDaemonServer(resolveDaemonRuntimePaths(["--home", home], {
      OCTO_HARNESS_MANIFEST: join(root, "test/fixtures/adapters.json"),
      OCTO_HARNESS_ADAPTER_HOST: join(root, "apps/adapter-host/dist/index.js")
    }));
    this.state = "running";
  }

  async stop() {
    if (this.app) await this.app.close();
    this.app = undefined;
    if (this.state !== "not_installed") this.state = "stopped";
  }

  async restart(spec = this.spec) {
    await this.stop();
    await this.start(spec);
  }
}

test("setup and service CLI complete enrollment, online readiness, lifecycle, doctor, and update recovery", async () => {
  const home = await mkdtemp(process.platform === "win32"
    ? join(tmpdir(), "oh-cli-lifecycle-")
    : "/tmp/oh-cli-");
  const worker = createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  const backend = new InMemoryServiceBackend();
  const output = [];
  let enrollmentCount = 0;
  let runtimeRegistrationCount = 0;

  worker.on("request", async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method === "POST" && request.url === "/api/v1/devices/enroll") {
      enrollmentCount += 1;
      const workProfile = request.headers.authorization === "Bearer octo_enroll_work";
      assert.ok(workProfile || request.headers.authorization === "Bearer octo_enroll_fixture");
      assert.match(body, /"system_id":"system_/);
      response.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({
        device: {
          id: workProfile ? "device-work" : "device-fixture",
          octo_space_id: workProfile ? "space-work" : "space-fixture",
          owner_user_id: workProfile ? "user-work" : "user-fixture"
        },
        credential: workProfile
          ? { id: "credential-work", token: "octo_device_work_secret" }
          : { id: "credential-fixture", token: "octo_device_fixture_secret" }
      }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/runtime/register") {
      runtimeRegistrationCount += 1;
      const workProfile = request.headers.authorization === "Bearer octo_device_work_secret";
      assert.ok(workProfile || request.headers.authorization === "Bearer octo_device_fixture_secret");
      assert.equal(request.headers["x-tenant-id"], undefined);
      assert.equal(request.headers["x-subject-id"], undefined);
      response.writeHead(runtimeRegistrationCount === 1 ? 201 : 200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ runtime: { id: workProfile ? "runtime-work" : "runtime-fixture" } }));
      return;
    }
    response.writeHead(404).end();
  });
  worker.on("upgrade", (request, socket, head) => {
    webSockets.handleUpgrade(request, socket, head, client => webSockets.emit("connection", client, request));
  });
  webSockets.on("connection", socket => {
    socket.on("message", data => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "runtime.hello") {
        socket.send(wire("runtime.welcome", { heartbeat_every_ms: 60_000 }));
      }
    });
  });

  const dependencies = {
    backend,
    output: value => output.push(value),
    daemonEntrypoint: join(root, "apps/daemon/dist/launcher.js")
  };
  const invoke = async (args, extra = {}) => {
    output.length = 0;
    const exitCode = await runCli(["--home", home, ...args], { ...dependencies, ...extra });
    return { exitCode, output: output.join("\n"), value: output.length ? JSON.parse(output.at(-1)) : undefined };
  };

  try {
    await new Promise(resolve => worker.listen(0, "127.0.0.1", resolve));
    const address = worker.address();
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const setup = await invoke([
      "login",
      "--server-url", serverUrl,
      "--enroll-token-stdin",
      "--wait-online",
      "--timeout-ms", "5000"
    ], { input: Readable.from(["octo_enroll_fixture\n"]) });

    assert.equal(setup.exitCode, 0);
    assert.equal(setup.value.enrolled, true);
    assert.equal(setup.value.runtime_id, "runtime-fixture");
    assert.equal(setup.value.readiness.agentWork.connected, true);
    assert.equal(backend.state, "running");
    assert.equal(backend.enabled, true);
    assert.equal(enrollmentCount, 1);
    assert.ok(runtimeRegistrationCount >= 2);
    assert.doesNotMatch(JSON.stringify(backend.spec), /octo_enroll_fixture|octo_device_fixture_secret/);
    assert.doesNotMatch(setup.output, /octo_enroll_fixture|octo_device_fixture_secret/);

    const identity = JSON.parse(await readFile(join(home, "identity/runtime.json"), "utf8"));
    const credential = JSON.parse(await readFile(join(home, "credentials/runtime-token.json"), "utf8"));
    assert.equal(identity.runtime_id, "runtime-fixture");
    assert.match(identity.system_id, /^system_/);
    assert.equal(credential.access_token, "octo_device_fixture_secret");
    if (process.platform !== "win32") {
      assert.equal((await stat(join(home, "credentials/runtime-token.json"))).mode & 0o077, 0);
    }

    const status = await invoke(["daemon", "status"]);
    assert.equal(status.value.service.state, "running");
    assert.equal(status.value.application.lifecycle.draining, false);
    assert.equal(status.value.application.agentWork.runtimeId, identity.runtime_id);

    const doctor = await invoke(["doctor"]);
    assert.equal(doctor.exitCode, 0);
    assert.equal(doctor.value.ok, true);

    await assert.rejects(
      invoke([
        "--profile", "work",
        "login",
        "--server-url", serverUrl,
        "--enroll-token-stdin"
      ], { input: Readable.from(["octo_enroll_work\n"]) }),
      /already bound to profile default/
    );
    assert.equal(enrollmentCount, 1);
    const rootConfig = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    assert.deepEqual(rootConfig.enabled_profiles, ["default"]);
    assert.doesNotMatch(JSON.stringify(backend.spec), /octo_device_fixture_secret/);

    const restarted = await invoke(["daemon", "restart", "--timeout-ms", "5000"]);
    assert.equal(restarted.value.action, "restart");
    assert.equal(restarted.value.readiness.ready, true);

    const prepared = await invoke(["setup", "--prepare-update", "--wait-drained", "--timeout-ms", "5000"]);
    assert.equal(prepared.value.service_was_running, true);
    assert.equal(backend.state, "stopped");
    const recovered = await invoke(["setup", "--recover-update", "--start"]);
    assert.equal(recovered.value.started, true);
    assert.equal(backend.state, "running");

    const repeated = await invoke(["login", "--server-url", serverUrl, "--wait-online", "--timeout-ms", "5000"]);
    assert.equal(repeated.value.enrolled, false);
    assert.equal(enrollmentCount, 1);

    const stopped = await invoke(["daemon", "stop", "--timeout-ms", "5000"]);
    assert.equal(stopped.value.service.state, "stopped");
    await assert.rejects(access(join(home, "octo-daemon.pid")), error => error.code === "ENOENT");

    const started = await invoke(["daemon", "start", "--timeout-ms", "5000"]);
    assert.equal(started.value.action, "start");
    assert.equal(started.value.readiness.ready, true);
    await invoke(["daemon", "stop", "--timeout-ms", "5000"]);

    let foregroundArgs;
    const foreground = await invoke(["daemon", "run"], {
      runForegroundDaemon: async args => { foregroundArgs = args; }
    });
    assert.equal(foreground.exitCode, 0);
    assert.deepEqual(foregroundArgs, ["--home", home]);
    const foregroundFailure = await invoke(["daemon", "run"], {
      runForegroundDaemon: async () => 23
    });
    assert.equal(foregroundFailure.exitCode, 23);
  } finally {
    await backend.stop();
    for (const client of webSockets.clients) client.terminate();
    await new Promise(resolve => webSockets.close(() => resolve()));
    await new Promise(resolve => worker.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
