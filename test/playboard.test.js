import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePlayboard } from "../apps/cli/dist/playboard.js";
import { assertHostFrame, isHostTerminal, assertCanonicalEvent, isTerminal } from "@mininglamp-oss/octo-runtime-protocol";

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

function execute({ directory, manifest }, value, { args = [], signalOnFrame = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "playboard", "--manifest", manifest, ...args], {
      cwd: directory,
      env: {
        ...process.env,
        OCTO_RUNTIME_HOME: join(directory, "unconfigured-home"),
        OCTO_RUNTIME_DEBUG: "0"
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
  result.frames.forEach(frame => 'kind' in frame ? assertHostFrame(frame) : assertCanonicalEvent(frame));
  assert.equal(result.frames.filter(frame => 'kind' in frame ? isHostTerminal(frame) : isTerminal(frame)).length, 1);
  const last = result.frames.at(-1);
  assert.equal('kind' in last ? last.control.state : last.type, 'kind' in last ? state : `run.${state}`);
}
function observed(result) {
  return JSON.parse(
    result.frames.find(
      (frame) => frame.type === "message.delta"
    ).payload.text
  );
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

test("independent Host renders ordered business context, keeps control separate, and persists no Runtime state", async (t) => {
  const settings = await fixture(t);
  const contexts = [
    item("extra.playboard", "second", { text: "business-b" }),
    item("octo.control", "instructions", {
      entries: [{ source: "agent_configuration", text: "control-only" }]
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
  const repeated = await execute(settings, request);
  assert.equal(observed(repeated).modelInput, wire.modelInput);
  const empty = await execute(settings, { ...echoInput(), sessionId: "same-session" });
  assert.equal(observed(empty).modelInput, "hello");
  assert.deepEqual(await readdir(settings.directory), ["adapters.json"]);
});

for (const protocolMode of ["native", "canonical"]) {
  test(`real Codex adapter emits ${protocolMode} frames through standalone Host`, async (t) => {
    const settings = await fixture(t);
    const result = await execute(settings, input("normal", { protocol_mode: protocolMode }));
    assert.equal(result.code, 0, result.stderr);
    terminal(result, "completed");
    assert.ok(result.frames.some((frame) => protocolMode === "native" ? frame.kind === "native" : frame.type === "run.completed"));
    assert.ok(result.frames.every((frame) => protocolMode === "native" ? frame.protocol_mode === "native" : !('kind' in frame)));
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
      !result.frames.some((frame) => 'kind' in frame ? isHostTerminal(frame) && frame.control.state === "completed" : frame.type === "run.completed")
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

test("Ctrl+C cancels execution and reaps the independent Host", async (t) => {
  const settings = await fixture(t);
  const result = await execute(settings, echoInput("hang"), { signalOnFrame: true });
  assert.equal(result.code, 130, result.stderr);
  const frame = result.frames.find(
    (frame) => frame.type === "message.delta"
  );
  if (frame)
    assert.throws(() => process.kill(JSON.parse(frame.payload.text).hostPid, 0), {
      code: "ESRCH"
    });
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
  assert.match(args.stderr, /accepts only/);
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
