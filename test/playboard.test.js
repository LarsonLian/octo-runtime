import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareInvokeInput as preparePlayboard } from "@mininglamp-oss/octo-runtime-executor-core";
import { startTemporaryDaemon } from "../apps/cli/dist/temporary-daemon.js";
import { startDaemonServer } from "@mininglamp-oss/octo-runtime-daemon";
import { callDaemon } from "@mininglamp-oss/octo-runtime-daemon/runtime/runtime-contract";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  assertHostFrame,
  isHostTerminal,
  assertCanonicalEvent,
  isTerminal
} from "@mininglamp-oss/octo-runtime-protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "apps/cli/dist/index.js");
const context = (items) => ({ schema: "octo.context-envelope/v3", items });
const item = (namespace, name, payload) => ({ namespace, name, payload });
const input = (text = "hello", overrides = {}) => ({
  inputs: [{ type: "text", text }],
  contexts: context([]),
  ...overrides
});
const echoInput = (text = "hello", extra = []) =>
  input(text, {
    protocol_mode: "canonical",
    contexts: context([item("octo.execution", "adapter", { type: "playboard-test" }), ...extra])
  });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "octo-playboard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = join(directory, "adapters.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      adapters: [
        {
          type: "openclaw",
          module: join(root, "packages/octo-runtime-adapter-openclaw/dist/index.js"),
          export: "createOpenClawAdapter",
          factory: true
        },
        {
          type: "playboard-test",
          module: join(root, "test/fixtures/playboard-adapter.js"),
          export: "playboardAdapter"
        },
        {
          type: "codex",
          module: join(root, "packages/octo-runtime-adapter-codex/dist/index.js"),
          export: "createCodexAdapter",
          factory: true,
          options: {
            command: process.execPath,
            appServerArgs: [join(root, "test-support/fake-native-codex.mjs")]
          }
        }
      ]
    })
  );
  return { directory, manifest };
}

function execute(
  { directory, manifest },
  value,
  { args = [], signalOnFrame = false, env = {} } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "playboard", "--manifest", manifest, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_HOME: join(directory, "absent-openclaw"),
        OCTO_RUNTIME_HOME: join(directory, "unconfigured-home"),
        OCTO_RUNTIME_DEBUG: "0",
        ...env
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "",
      stderr = "",
      signalled = false;
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("playboard did not exit"));
    }, 15_000);
    child.on("error", reject);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (signalOnFrame && !signalled && stdout.includes('"type":"message.delta"')) {
        signalled = true;
        child.kill("SIGINT");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      const frames = stdout.trim()
        ? stdout
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      resolve({ code, signal, stdout, stderr, frames });
    });
    child.stdin.end(typeof value === "string" ? value : JSON.stringify(value));
  });
}

function terminal(result, state) {
  result.frames.forEach((frame) =>
    "kind" in frame ? assertHostFrame(frame) : assertCanonicalEvent(frame)
  );
  assert.equal(
    result.frames.filter((frame) => ("kind" in frame ? isHostTerminal(frame) : isTerminal(frame)))
      .length,
    1
  );
  const last = result.frames.at(-1);
  assert.equal(
    "kind" in last ? last.control.state : last.type,
    "kind" in last ? state : `run.${state}`
  );
}
function observed(result) {
  return JSON.parse(result.frames.find((frame) => frame.type === "message.delta").payload.text);
}

test("playboard maps one snapshot and never invents provider continuity", () => {
  const request = input("first", { sessionId: "same-session" });
  const first = preparePlayboard(request);
  const second = preparePlayboard(request);
  assert.equal(first.protocolMode, "native");
  assert.equal(first.adapterType, "codex");
  assert.equal(first.request.agentSessionId, "same-session");
  assert.equal(first.request.continuityMode, "fresh");
  assert.equal(first.request.providerSession, undefined);
  assert.notEqual(first.request.runId, second.request.runId);
  assert.notEqual(first.request.invocationId, second.request.invocationId);
  assert.deepEqual(request.contexts, context([]));
  const continued = preparePlayboard({
    ...request,
    providerSession: { sessionId: "opaque", custom: { keep: true } }
  });
  assert.equal(continued.request.continuityMode, "continue");
  assert.deepEqual(continued.request.providerSession, {
    sessionId: "opaque",
    custom: { keep: true }
  });
});

test("OpenClaw shorthand selects an existing agent without injecting a caller workspace", () => {
  const adapter = (payload) => context([item("octo.execution", "adapter", payload)]);
  const submitted = input("hello", {
    protocol_mode: "canonical",
    contexts: adapter({ type: "openclaw" })
  });
  const snapshot = structuredClone(submitted);
  const prepared = preparePlayboard(submitted);
  assert.deepEqual(submitted, snapshot);
  assert.equal(prepared.adapterType, "openclaw");
  assert.equal(prepared.protocolMode, "canonical");
  assert.equal(prepared.request.agentSource, "preset");
  assert.equal(prepared.request.agentConfig.providerAgentId, "main");
  assert.equal(prepared.request.workdir, "");
  assert.ok(!prepared.request.context.items.some((entry) => entry.name === "workspace"));
  assert.deepEqual(
    prepared.request.context.items.find((entry) => entry.name === "adapter").payload,
    { type: "openclaw", provider_agent_id: "main" }
  );
  const explicit = preparePlayboard({
    ...submitted,
    agentSource: "provisioned",
    contexts: adapter({ type: "openclaw", provider_agent_id: "researcher" })
  });
  assert.equal(explicit.request.agentSource, "provisioned");
  assert.equal(explicit.request.agentConfig.providerAgentId, "researcher");
  assert.equal(explicit.request.workdir, process.cwd());
  for (const provider_agent_id of [null, undefined, "", " ", "../main", 42]) {
    assert.throws(
      () =>
        preparePlayboard({
          ...submitted,
          contexts: adapter({ type: "openclaw", provider_agent_id })
        }),
      /CONTEXT_SCHEMA_INVALID/
    );
  }
});

test("invalid input, old context, and invalid continuity fail before execution", () => {
  for (const value of [
    null,
    [],
    input(""),
    input("hello", { inputs: [] }),
    input("hello", { protocol_mode: "other" }),
    input("hello", { protocolMode: "canonical" }),
    input("hello", { contexts: { schema: "octo.context-envelope/v2", items: [] } }),
    input("hello", { sessionId: 3 }),
    input("hello", { continuityMode: "continue" }),
    input("hello", { providerSession: {} }),
    input("hello", { providerSession: { sessionId: "x", resumable: "yes" } }),
    input("hello", { continuityMode: "fresh", providerSession: { sessionId: "x" } })
  ]) {
    assert.throws(() => preparePlayboard(value));
  }
  assert.equal(preparePlayboard(input("hello", { extra: true })).request.modelInput, "hello");
});

test("temporary daemon renders ordered context and leaves no identity or process state", async (t) => {
  const settings = await fixture(t);
  const contexts = [
    item("extra.playboard", "second", { text: "business-b" }),
    item("octo.control", "instructions", {
      entries: [{ text: "control-only" }]
    }),
    item("extra.playboard", "first", { text: "business-a" }),
    item("octo.execution", "model", { selection: { id: "test-model" } })
  ];
  const request = { ...echoInput("hello", contexts), sessionId: "same-session" };
  const result = await execute(settings, request);
  assert.equal(result.code, 0, result.stderr);
  terminal(result, "completed");
  const wire = observed(result);
  assert.equal(wire.agentSessionId, "same-session");
  assert.equal(wire.workdir, await realpath(settings.directory));
  assert.equal(wire.agentConfig.model, "test-model");
  assert.equal(wire.controlInstructions, "control-only");
  assert.ok(wire.modelInput.indexOf("business-b") < wire.modelInput.indexOf("business-a"));
  assert.doesNotMatch(wire.modelInput, /control-only|test-model/);
  assert.match(result.stderr, /playboard fixture diagnostic/);
  assert.doesNotMatch(result.stdout, /playboard fixture diagnostic/);
  assert.throws(() => process.kill(wire.hostPid, 0), { code: "ESRCH" });
  assert.throws(() => process.kill(wire.daemonPid, 0), { code: "ESRCH" });
  assert.equal(wire.runMetadata.profile, "default");
  const repeated = await execute(settings, request);
  assert.equal(observed(repeated).modelInput, wire.modelInput);
  const empty = await execute(settings, { ...echoInput(), sessionId: "same-session" });
  assert.equal(observed(empty).modelInput, "hello");
  assert.deepEqual(await readdir(settings.directory), ["adapters.json"]);
});

for (const protocolMode of ["native", "canonical"]) {
  test(`real Codex adapter emits ${protocolMode} frames through temporary daemon IPC`, async (t) => {
    const settings = await fixture(t);
    const result = await execute(settings, input("normal", { protocol_mode: protocolMode }));
    assert.equal(result.code, 0, result.stderr);
    terminal(result, "completed");
    assert.ok(
      result.frames.some((frame) =>
        protocolMode === "native" ? frame.kind === "native" : frame.type === "run.completed"
      )
    );
    assert.ok(
      result.frames.every((frame) =>
        protocolMode === "native" ? frame.protocol_mode === "native" : !("kind" in frame)
      )
    );
    if (protocolMode === "native") {
      assert.deepEqual(
        result.frames.find((frame) => frame.kind === "native").payload.result.future,
        { exact: true }
      );
    }
  });
  test(`${protocolMode} pending interaction fails without hanging or auto-approving`, async (t) => {
    const settings = await fixture(t);
    const result = await execute(settings, input("approval", { protocol_mode: protocolMode }));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PLAYBOARD_INTERACTION_REQUIRED/);
    assert.ok(result.frames.length > 0);
    assert.ok(
      !result.frames.some((frame) =>
        "kind" in frame
          ? isHostTerminal(frame) && frame.control.state === "completed"
          : frame.type === "run.completed"
      )
    );
  });
}

test("provider failure and deadline exit nonzero with terminal frames", async (t) => {
  const settings = await fixture(t);
  for (const request of [
    echoInput("fail"),
    echoInput("hang", [
      item("octo.execution", "limits", { run_timeout_ms: 150, cancel_grace_ms: 100 })
    ])
  ]) {
    const result = await execute(settings, request);
    assert.equal(result.code, 1, result.stderr);
    terminal(result, "failed");
  }
});

test("Ctrl+C cancels execution and reaps the temporary daemon and Host", async (t) => {
  const settings = await fixture(t);
  const result = await execute(settings, echoInput("hang"), { signalOnFrame: true });
  assert.equal(result.code, 130, result.stderr);
  const frame = result.frames.find((frame) => frame.type === "message.delta");
  if (frame) {
    assert.throws(() => process.kill(JSON.parse(frame.payload.text).hostPid, 0), {
      code: "ESRCH"
    });
    assert.throws(() => process.kill(JSON.parse(frame.payload.text).daemonPid, 0), {
      code: "ESRCH"
    });
  }
});

test("malformed stdin, unknown arguments and unsupported native mode fail clearly", async (t) => {
  const settings = await fixture(t);
  for (const value of ["", "{", "{}\n{}", "[]", "{}SECRET-do-not-echo"]) {
    const result = await execute(settings, value);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /SECRET-do-not-echo/);
  }
  const args = await execute(settings, echoInput(), { args: ["--unknown", "value"] });
  assert.equal(args.code, 1);
  assert.match(args.stderr, /unknown option/);
  const unsupported = await execute(settings, { ...echoInput(), protocol_mode: "native" });
  assert.equal(unsupported.code, 1);
  assert.equal(unsupported.stdout, "");
  assert.match(unsupported.stderr, /PROTOCOL_MODE_UNSUPPORTED/);
});

test("closing the NDJSON consumer cleans up Host and provider execution", async (t) => {
  const settings = await fixture(t);
  const child = spawn(process.execPath, [cli, "playboard", "--manifest", settings.manifest], {
    cwd: settings.directory,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let output = "",
    hostPid;
  child.stderr.resume();
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const line of output.split("\n").slice(0, -1)) {
      const frame = JSON.parse(line);
      if (frame.type === "message.delta") {
        hostPid = JSON.parse(frame.payload.text).hostPid;
        child.stdout.destroy();
        break;
      }
    }
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("broken pipe did not clean up"));
    }, 10_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.stdin.end(JSON.stringify(echoInput("broken-pipe")));
  });
  assert.equal(code, 1);
  assert.equal(typeof hostPid, "number");
  assert.throws(() => process.kill(hostPid, 0), { code: "ESRCH" });
});

test("temporary IPC and parallel playboards preserve a resident daemon and persistent profile", async (t) => {
  const settings = await fixture(t);
  const home = join(settings.directory, "unconfigured-home");
  const profileRoot = join(home, "work");
  await mkdir(join(profileRoot, "identity"), { recursive: true });
  const identity = join(profileRoot, "identity/runtime.json");
  await writeFile(identity, "existing-runtime-identity\n");
  const extra = join(home, "extras");
  await mkdir(extra, { recursive: true });
  // Parsing this file would fail: temporary execution must not load the channels.
  await writeFile(join(extra, "channel-gateway.json"), "not valid JSON");
  const resident = await startDaemonServer({
    homePath: home,
    socketPath: join(settings.directory, "resident.sock"),
    manifestPath: settings.manifest,
    hostEntrypoint: join(root, "packages/octo-runtime-adapter-host/dist/runner.js")
  });
  try {
    const ledger = join(home, "run/invocations.json");
    const before = await readFile(ledger, "utf8");
    const temporary = await startTemporaryDaemon({
      home,
      profile: "work",
      manifest: settings.manifest,
      env: {
        ...process.env,
        OPENCLAW_HOME: join(settings.directory, "absent-openclaw"),
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined
      },
      signal: new AbortController().signal
    });
    const status = await callDaemon(temporary.socket, { method: "status" });
    assert.equal(status.ready, true);
    assert.deepEqual(status.extras, {});
    assert.notEqual(status.adapterHost.pid, resident.hostProcess.child.pid);
    await temporary.close();
    assert.throws(() => process.kill(status.pid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(status.adapterHost.pid, 0), { code: "ESRCH" });
    if (process.platform !== "win32")
      await assert.rejects(stat(temporary.socket), { code: "ENOENT" });
    const runs = await Promise.all([
      execute(settings, echoInput(), { args: ["--profile", "work"] }),
      execute(settings, echoInput(), { args: ["--profile", "work"] })
    ]);
    for (const run of runs) {
      assert.equal(run.code, 0, run.stderr);
      terminal(run, "completed");
      assert.equal(observed(run).runMetadata.profile, "work");
    }
    assert.notEqual(observed(runs[0]).daemonPid, observed(runs[1]).daemonPid);
    assert.equal(await readFile(ledger, "utf8"), before);
    assert.equal(await readFile(identity, "utf8"), "existing-runtime-identity\n");
    assert.equal((await callDaemon(resident.runtime.socketPath, { method: "status" })).ready, true);
    const conflict = await execute(settings, { ...echoInput(), runMetadata: { profile: "other" } });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /request profile differs/);
  } finally {
    await resident.close();
  }
});

test("OpenClaw uses daemon startup configuration, refreshes its source and retains device identity", async (t) => {
  const settings = await fixture(t);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  t.after(() => {
    for (const client of gateway.clients) client.terminate();
    return new Promise((resolve) => gateway.close(resolve));
  });
  let token = "first-test-token";
  const authenticated = [];
  const methods = [];
  gateway.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "playboard", ts: Date.now() }
      })
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      methods.push(frame.method);
      let payload = {};
      if (frame.method === "connect") {
        authenticated.push(frame.params.auth.token);
        const ok = frame.params.auth.token === token;
        socket.send(
          JSON.stringify({
            type: "res",
            id: frame.id,
            ok,
            ...(ok
              ? {
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
                }
              : { error: { message: "test authentication failed" } })
          })
        );
        return;
      }
      if (frame.method === "agents.list") payload = { agents: [{ id: "main" }] };
      if (frame.method === "sessions.create") payload = { key: frame.params.key };
      if (frame.method === "agent")
        payload = { status: "ok", result: { payloads: [{ text: "gateway-result" }] } };
      if (frame.method === "agent.wait") payload = { status: "ok" };
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  const source = join(settings.directory, "provider");
  await mkdir(source);
  const config = join(source, "openclaw.json");
  const save = () =>
    writeFile(
      config,
      JSON.stringify({ gateway: { port: gateway.address().port, auth: { token } } })
    );
  await save();
  const request = input("hello", {
    protocol_mode: "canonical",
    contexts: context([
      item("octo.execution", "adapter", { type: "openclaw" }),
      item("octo.security", "approval_policy", { mode: "full_access" })
    ])
  });
  const profile = join(settings.directory, "unconfigured-home/work");
  const run = () =>
    execute(settings, request, { args: ["--profile", "work"], env: { OPENCLAW_HOME: source } });
  const first = await run();
  assert.equal(first.code, 0, first.stderr);
  terminal(first, "completed");
  assert.match(first.stdout, /gateway-result/);
  const deviceFile = join(profile, "credentials/openclaw-device.json");
  const device = await readFile(deviceFile, "utf8");
  token = "rotated-test-token";
  await save();
  const second = await run();
  assert.equal(second.code, 0, second.stderr);
  terminal(second, "completed");
  assert.ok(authenticated.includes(token));
  assert.equal(await readFile(deviceFile, "utf8"), device);
  assert.ok(methods.includes("sessions.messages.subscribe"));
  const unreachableConfig = JSON.stringify({ gateway: { port: 1, auth: { token } } });
  await writeFile(config, unreachableConfig);
  const unavailable = await run();
  assert.equal(unavailable.code, 1);
  terminal(unavailable, "failed");
  assert.equal(await readFile(config, "utf8"), unreachableConfig);
  assert.equal(await readFile(deviceFile, "utf8"), device);
});

test("daemon startup failure removes temporary process state and keeps stdout empty", async (t) => {
  const settings = await fixture(t);
  const isolated = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "op-state-")
  );
  t.after(() => rm(isolated, { recursive: true, force: true }));
  const result = await execute(
    { ...settings, manifest: join(settings.directory, "missing-manifest.json") },
    echoInput(),
    {
      env: { TMPDIR: isolated, TEMP: isolated, TMP: isolated }
    }
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(await readdir(isolated), []);
});

test("cancelling daemon startup waits for resource cleanup and preserves prepared configuration", async (t) => {
  const settings = await fixture(t);
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(gateway, "listening");
  t.after(() => {
    for (const client of gateway.clients) client.terminate();
    return new Promise((resolve) => gateway.close(resolve));
  });
  const controller = new AbortController();
  // Hold the Provider probe at its authentication handshake, then cancel startup.
  gateway.once("connection", () => controller.abort());
  const home = join(settings.directory, "runtime");
  const isolated = await mkdtemp(
    join(process.platform === "darwin" ? "/tmp" : tmpdir(), "op-state-")
  );
  t.after(() => rm(isolated, { recursive: true, force: true }));
  const temporaryVariable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const previous = process.env[temporaryVariable];
  process.env[temporaryVariable] = isolated;
  try {
    await assert.rejects(
      startTemporaryDaemon({
        home,
        profile: "work",
        manifest: settings.manifest,
        env: {
          ...process.env,
          OPENCLAW_HOME: undefined,
          OPENCLAW_GATEWAY_URL: `ws://127.0.0.1:${gateway.address().port}`,
          OPENCLAW_GATEWAY_TOKEN: "test-startup-token"
        },
        signal: controller.signal
      }),
      /startup cancelled/
    );
  } finally {
    if (previous === undefined) delete process.env[temporaryVariable];
    else process.env[temporaryVariable] = previous;
  }
  assert.deepEqual(await readdir(isolated), []);
  assert.ok(await stat(join(home, "work/credentials/openclaw-device.json")));
});
