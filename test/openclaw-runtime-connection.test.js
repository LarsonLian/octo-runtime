import { createHostInvoke as preparedTestInvoke } from "@mininglamp-oss/octo-runtime-protocol";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { waitFor } from "./runtime-fixture.js";
import {
  configureOpenClawConnection,
  loadLocalOpenClawGateway,
  createOpenClawAdapter
} from "@mininglamp-oss/octo-runtime-adapter-openclaw";
import { configureCliOpenClaw } from "@mininglamp-oss/octo-runtime-daemon-app/openclaw";
import {
  AdapterHost,
  AdapterHostRpcClient,
  AdapterHostRpcServer
} from "@mininglamp-oss/octo-runtime-adapter-host";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "oh-connections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("connection sources are persisted per Runtime, with precedence and fail-closed behavior", async (t) => {
  const root = await fixture(t);
  const one = join(root, "one"),
    two = join(root, "two"),
    source = join(root, "native");
  await mkdir(source);
  await writeFile(
    join(source, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "home-token" }, port: 19100 } })
  );
  await configureCliOpenClaw(
    one,
    { openclawHome: source },
    { OPENCLAW_GATEWAY_URL: "invalid", OPENCLAW_GATEWAY_TOKEN: "ignored" }
  );
  const connection = await configureCliOpenClaw(
    two,
    {},
    { OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19101", OPENCLAW_GATEWAY_TOKEN: "manual-token" }
  );
  const [a, b] = await Promise.all([loadLocalOpenClawGateway(one), loadLocalOpenClawGateway(two)]);
  assert.equal(a.token, "home-token");
  assert.equal(b.token, "manual-token");
  assert.notEqual(a.device.deviceId, b.device.deviceId);
  assert.equal((await configureCliOpenClaw(two, {}, { OPENCLAW_HOME: source })).source, "gateway");
  assert.equal((await loadLocalOpenClawGateway(two)).token, "manual-token");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(two, connection.credential_ref))).mode & 0o777, 0o600);
    assert.equal((await stat(join(two, "credentials/openclaw-device.json"))).mode & 0o777, 0o600);
  }
  assert.equal(
    (await readFile(join(two, "adapters/openclaw/connection.json"), "utf8")).includes(
      "manual-token"
    ),
    false
  );
  await configureOpenClawConnection(one, { url: "ws://127.0.0.1:19102", token: "new-token" });
  const changed = await loadLocalOpenClawGateway(one);
  assert.equal(changed.token, "new-token");
  assert.deepEqual(changed.device, a.device);
  await rm(join(two, connection.credential_ref));
  await assert.rejects(loadLocalOpenClawGateway(two), /gateway_credential_invalid/);
  await assert.rejects(
    configureOpenClawConnection(two, { url: "ws://127.0.0.1:19103" }),
    /gateway_url_and_token_required/
  );
  await assert.rejects(
    configureCliOpenClaw(two, {
      openclawHome: source,
      url: "ws://127.0.0.1:19103",
      token: "x"
    }),
    /connection_sources_conflict/
  );
  await assert.rejects(
    configureOpenClawConnection(two, { url: "ws://remote.example:18789", token: "x" }),
    /remote_gateway_requires_wss/
  );
});

test("CLI refreshes discovered WS/token on every startup and SDK reads only the saved snapshot", async (t) => {
  const root = await fixture(t);
  const source = join(root, "native");
  const runtime = join(root, "runtime");
  await mkdir(source);
  const save = (port, token) =>
    writeFile(
      join(source, "openclaw.json"),
      JSON.stringify({ gateway: { port, auth: { token } } })
    );
  await save(19110, "first");
  await configureCliOpenClaw(runtime, {}, { OPENCLAW_HOME: source });
  const first = await loadLocalOpenClawGateway(runtime);
  await save(19111, "rotated");
  assert.equal((await loadLocalOpenClawGateway(runtime)).token, "first");
  await configureCliOpenClaw(runtime, {}, { OPENCLAW_HOME: "/must-not-override-saved-source" });
  const next = await loadLocalOpenClawGateway(runtime);
  assert.equal(next.url, "ws://127.0.0.1:19111/");
  assert.equal(next.token, "rotated");
  assert.deepEqual(next.device, first.device);
  await configureCliOpenClaw(runtime, { url: "ws://127.0.0.1:19112", token: "explicit" });
  await save(19113, "ignored");
  await configureCliOpenClaw(runtime, {}, { OPENCLAW_HOME: source });
  assert.equal((await loadLocalOpenClawGateway(runtime)).token, "explicit");
  assert.equal(
    JSON.parse(await readFile(join(source, "openclaw.json"), "utf8")).gateway.auth.token,
    "ignored"
  );
});

test("unconfigured SDK probe does not discover or create files; missing device is not repaired", async (t) => {
  const root = await fixture(t);
  const runtime = join(root, "runtime");
  const probe = await createOpenClawAdapter().probe({
    providerOptions: { OPENCLAW_RUNTIME_ROOT: runtime }
  });
  assert.equal(probe.available, false);
  assert.equal(probe.reason, "runtime_configuration_missing");
  assert.deepEqual(await readdir(root), []);
  await configureOpenClawConnection(runtime, { url: "ws://127.0.0.1:19114", token: "explicit" });
  const device = join(runtime, "credentials", "openclaw-device.json");
  await rm(device);
  await assert.rejects(loadLocalOpenClawGateway(runtime), /device_identity_invalid/);
  await assert.rejects(stat(device), { code: "ENOENT" });
});

test("CLI daemon restart refreshes and authenticates rotated Home connection without SDK discovery", async (t) => {
  const root = await fixture(t);
  const source = join(root, "native");
  const home = join(root, "runtime");
  await mkdir(source);
  const authenticated = [];
  const gateways = [];
  for (const token of ["before", "after"]) {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    gateways.push(server);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    server.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "rotation", ts: Date.now() }
        })
      );
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.method === "connect") {
          assert.equal(frame.params.auth.token, token);
          authenticated.push(token);
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: true,
              payload: {
                type: "hello-ok",
                protocol: 4,
                features: {
                  methods: [
                    "agents.list",
                    "sessions.create",
                    "sessions.messages.subscribe",
                    "agent",
                    "agent.wait",
                    "sessions.abort"
                  ],
                  events: ["agent"]
                }
              }
            })
          );
        } else
          socket.send(
            JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { agents: [] } })
          );
      });
    });
  }
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const env = { ...process.env, OPENCLAW_HOME: source };
  delete env.OPENCLAW_GATEWAY_URL;
  delete env.OPENCLAW_GATEWAY_TOKEN;
  let previousDevice;
  for (const [index, token] of ["before", "after"].entries()) {
    await writeFile(
      join(source, "openclaw.json"),
      JSON.stringify({
        gateway: {
          port: gateways[index].address().port,
          auth: { token }
        }
      })
    );
    if (index === 0) await configureCliOpenClaw(join(home, "work"), {}, env);
    const child = spawn(
      process.execPath,
      [
        join(repo, "apps/daemon/dist/index.js"),
        "--home",
        home,
        "--socket",
        join(root, "d.sock"),
        "--manifest",
        join(repo, "test/fixtures/adapters.json")
      ],
      {
        env,
        stdio: ["ignore", "ignore", "pipe"]
      }
    );
    let diagnostics = "";
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    const exited = once(child, "exit");
    try {
      await waitFor(() => {
        if (child.exitCode !== null) throw new Error(diagnostics);
        const pid = join(home, "octo-daemon.pid");
        return (
          existsSync(pid) &&
          readFileSync(pid, "utf8").trim() === String(child.pid) &&
          existsSync(join(root, "d.sock")) &&
          authenticated.filter((value) => value === token).length >= 2
        );
      }, 5000);
      const snapshot = await loadLocalOpenClawGateway(join(home, "default"));
      assert.equal((await loadLocalOpenClawGateway(join(home, "work"))).token, token);
      assert.equal(snapshot.token, token);
      assert.equal(snapshot.url, `ws://127.0.0.1:${gateways[index].address().port}/`);
      if (previousDevice) assert.deepEqual(snapshot.device, previousDevice);
      previousDevice = snapshot.device;
    } finally {
      child.kill("SIGTERM");
      await exited;
    }
  }
});

test("shared Host probes and invokes each Runtime connection and uses only the Context Agent target", async (t) => {
  const root = await fixture(t);
  const roots = [join(root, "a"), join(root, "b")];
  await Promise.all(
    roots.map((dir, i) =>
      configureOpenClawConnection(dir, { url: `ws://127.0.0.1:${19200 + i}`, token: `token-${i}` })
    )
  );
  const observed = [];
  const adapter = createOpenClawAdapter({
    clientFactory: (options) => {
      const record = { url: options.url, token: options.token, methods: [] };
      observed.push(record);
      return {
        async connect() {
          return {
            protocol: 4,
            features: {
              methods: [
                "agents.list",
                "sessions.create",
                "sessions.messages.subscribe",
                "agent",
                "agent.wait",
                "sessions.abort"
              ],
              events: ["agent"]
            }
          };
        },
        onEvent() {
          return () => {};
        },
        async close() {},
        async request(method, params) {
          record.methods.push({ method, params });
          if (method === "agents.list") return { agents: [{ id: "researcher" }] };
          if (method === "sessions.create") return { key: params.key };
          if (method === "agent") return { status: "ok", result: { payloads: [{ text: "done" }] } };
          if (method === "agent.wait") return { status: "ok" };
          return {};
        }
      };
    }
  });
  const host = new AdapterHost();
  host.register(adapter);
  const requests = new PassThrough(),
    responses = new PassThrough();
  const server = new AdapterHostRpcServer({ host, input: requests, output: responses });
  server.listen(requests);
  const client = new AdapterHostRpcClient({ input: responses, output: requests });
  t.after(() => {
    client.close();
    requests.destroy();
    responses.destroy();
  });
  const configurations = roots.map((dir) => ({ providerOptions: { OPENCLAW_RUNTIME_ROOT: dir } }));
  const listings = await Promise.all(
    configurations.map((config) => client.list({ openclaw: config }))
  );
  assert.ok(listings.every((list) => list[0].available)); // no main Agent exists
  assert.deepEqual(new Set(observed.map((value) => value.token)), new Set(["token-0", "token-1"]));
  await Promise.all(configurations.map((config) => client.probe("openclaw", config)));
  // Rotation must be picked up without restarting the shared Host.
  await configureOpenClawConnection(roots[1], { url: "ws://127.0.0.1:19300", token: "rotated" });
  const request = {
    protocolVersion: 2,
    invocationId: "invoke-b",
    runId: "run-b",
    agentSessionId: "s",
    workdir: "",
    prompt: "work",
    modelInput: "work",
    controlInstructions: "",
    approvalMode: "full_access",
    agentSource: "preset",
    context: { schema: "octo.context-envelope/v3", items: [] },
    agentConfig: {
      providerAgentId: "researcher",
      providerOptions: {
        ...configurations[1].providerOptions,
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19999",
        OPENCLAW_GATEWAY_TOKEN: "must-not-win"
      }
    }
  };
  const events = [];
  for await (const event of preparedTestInvoke((...args) => client.invokeFrames(...args))(
    "openclaw",
    request,
    { protocolMode: "canonical" }
  ))
    events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
  const call = observed.at(-1);
  assert.equal(call.token, "rotated");
  assert.equal(call.url, "ws://127.0.0.1:19300/");
  assert.equal(call.methods.find((entry) => entry.method === "agent").params.agentId, "researcher");
  assert.equal(
    call.methods.some((entry) => ["agents.create", "config.patch"].includes(entry.method)),
    false
  );
  const { resolveOpenClawGateway } = await import("@mininglamp-oss/octo-runtime-adapter-openclaw");
  const snapshot = await loadLocalOpenClawGateway(roots[1]);
  const direct = {
    OPENCLAW_GATEWAY_URL: snapshot.url,
    OPENCLAW_GATEWAY_TOKEN: snapshot.token,
    OPENCLAW_GATEWAY_DEVICE_ID: snapshot.device.deviceId,
    OPENCLAW_GATEWAY_PUBLIC_KEY: snapshot.device.publicKey,
    OPENCLAW_GATEWAY_PRIVATE_KEY: snapshot.device.privateKey
  };
  assert.deepEqual(await resolveOpenClawGateway(direct), snapshot);
  assert.equal((await client.probe("openclaw", { providerOptions: direct })).available, true);
  request.runId = "run-sdk";
  request.invocationId = "invoke-sdk";
  request.agentConfig.providerOptions = direct;
  const sdkEvents = [];
  for await (const event of preparedTestInvoke((...args) => client.invokeFrames(...args))(
    "openclaw",
    request,
    { protocolMode: "canonical" }
  ))
    sdkEvents.push(event);
  assert.equal(sdkEvents.at(-1).type, "run.completed");
  assert.equal(observed.at(-1).token, call.token);
  assert.equal(observed.at(-1).url, call.url);
});
