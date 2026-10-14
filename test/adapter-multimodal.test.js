import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { createAcpAdapter } from "@mininglamp-oss/octo-runtime-adapter-acp";
import { acpPromptParams } from "@mininglamp-oss/octo-runtime-acp-client";
import { invokeRequest } from "./runtime-fixture.js";
import { visualInputImages } from "../test-support/multimodal-images.mjs";

const images = visualInputImages();
const mixed = [{ type: "text", text: "first" }, images[0], { type: "text", text: "second" }, images[1]];
const collect = async iterable => { const events = []; for await (const event of iterable) events.push(event); return events; };

function codexFixture({ fallback = false } = {}) {
  const child = new EventEmitter();
  const frames = [];
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const frame = JSON.parse(chunk.toString());
      frames.push(frame);
      if (frame.method === "initialize") send({ id: frame.id, result: {} });
      if (frame.method === "thread/start" || frame.method === "thread/resume") {
        send(frame.method === "thread/resume" && fallback
          ? { id: frame.id, error: { code: -32600, message: "thread not found" } }
          : { id: frame.id, result: { thread: { id: "fixture-thread" } } });
      }
      if (frame.method === "turn/start") {
        send({ id: frame.id, result: { turn: { id: "fixture-turn" } } });
        setImmediate(() => {
          send({ method: "item/agentMessage/delta", params: { threadId: "fixture-thread", turnId: "fixture-turn", itemId: "answer", delta: "done" } });
          send({ method: "turn/completed", params: { threadId: "fixture-thread", turnId: "fixture-turn", turn: { id: "fixture-turn", status: "completed" } } });
        });
      }
      callback();
    },
    final(callback) { child.exitCode = 0; child.stdout.end(); child.stderr.end(); child.emit("close", 0); callback(); }
  });
  child.kill = () => { child.exitCode = 0; child.emit("close", 0); return true; };
  return { spawnFn: () => child, frames };
}

for (const fallback of [false, true]) {
  test(`Codex preserves mixed native input order and redacts image captures${fallback ? " after resume fallback" : ""}`, async () => {
    const server = codexFixture({ fallback });
    const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
    const events = await collect(adapter.invoke(invokeRequest({
      modelInputParts: fallback ? [{ type: "text", text: "delta" }, images[1]] : mixed,
      ...(fallback ? { providerSession: { sessionId: "missing" }, freshFallbackModelInputParts: mixed } : {})
    })));
    const input = server.frames.find(frame => frame.method === "turn/start").params.input;
    assert.deepEqual(input, mixed.map(part => part.type === "image" ? { type: "image", url: `data:${part.mimeType};base64,${part.data}` } : { type: "text", text: part.text, text_elements: [] }));
    assert.equal(events.at(-1).type, "run.completed");
    if (fallback) assert.equal(events.find(event => event.type === "session.update").payload.providerSession.contextInputVariant, "recovery");
    assert.equal(adapter.metadata.executionFeatures.includes("input.image"), true);
  });
}

function acpFixture({ imageCapability = true, fallback = false } = {}) {
  let nextId = 1;
  const frames = [];
  let closed = false;
  return {
    frames, get closed() { return closed; },
    client: {
      initialize: async () => ({ agentCapabilities: { promptCapabilities: imageCapability === "missing" ? {} : { image: imageCapability } } }),
      reserveRequestId: () => nextId++,
      request: async (method, params) => { frames.push({ method, params }); return method === "session/load" && fallback ? null : { sessionId: "acp-fixture" }; },
      async *prompt(_session, _input, options) {
        frames.push({ method: "session/prompt", params: options.params });
        yield { sessionUpdate: "agent_message_chunk", content: { text: "done" } };
        yield { type: "prompt_result", stopReason: "end_turn" };
      },
      cancel() {}, close: async () => { closed = true; }
    }
  };
}

test("ACP transport accepts image blocks and retains its text-only API", () => {
  assert.deepEqual(acpPromptParams("s", "hello"), { sessionId: "s", prompt: [{ type: "text", text: "hello" }] });
  assert.deepEqual(acpPromptParams("s", mixed), { sessionId: "s", prompt: mixed.map(part => part.type === "image" ? { type: "image", mimeType: part.mimeType, data: part.data } : part) });
});

for (const fallback of [false, true]) {
  test(`ACP maps mixed native blocks and strips image captures${fallback ? " after load fallback" : ""}`, async () => {
    const fixture = acpFixture({ fallback });
    const adapter = createAcpAdapter({ type: "fixture", provider: "fixture", command: "fixture" }, { acpClientFactory: () => fixture.client });
    const events = await collect(adapter.invoke(invokeRequest({ modelInputParts: mixed, controlInstructions: "CONTROL", ...(fallback ? { providerSession: { sessionId: "missing" }, freshFallbackModelInputParts: [...mixed, images[2]] } : {}) })));
    const expected = [...mixed, ...(fallback ? [images[2]] : []), { type: "text", text: "CONTROL" }];
    assert.deepEqual(fixture.frames.find(frame => frame.method === "session/prompt").params, acpPromptParams("acp-fixture", expected));
    assert.equal(events.at(-1).type, "run.completed");
    assert.equal(fixture.closed, true);
  });
}

for (const imageCapability of [false, null, "true", "missing"]) {
  test(`ACP rejects unadvertised image support (${imageCapability}) before session or prompt`, async () => {
    const fixture = acpFixture({ imageCapability });
    const adapter = createAcpAdapter({ type: "fixture", provider: "fixture", command: "fixture" }, { acpClientFactory: () => fixture.client });
    await assert.rejects(collect(adapter.invoke(invokeRequest({ modelInputParts: images }))), /UNSUPPORTED_INPUT_MODALITY/);
    assert.deepEqual(fixture.frames, []);
    assert.equal(fixture.closed, true);
  });
}

test("Codex and ACP accept a pure-image turn without inventing user text", async () => {
  const server = codexFixture();
  const codex = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const codexEvents = await collect(codex.invoke(invokeRequest({ modelInput: "", modelInputParts: images })));
  assert.equal(codexEvents.at(-1).type, "run.completed");
  assert.deepEqual(server.frames.find(frame => frame.method === "turn/start").params.input.map(part => part.type), ["image", "image", "image"]);
  const fixture = acpFixture();
  const acp = createAcpAdapter({ type: "fixture", provider: "fixture", command: "fixture" }, { acpClientFactory: () => fixture.client });
  const acpEvents = await collect(acp.invoke(invokeRequest({ modelInput: "", modelInputParts: images, controlInstructions: "" })));
  assert.equal(acpEvents.at(-1).type, "run.completed");
  assert.deepEqual(fixture.frames.find(frame => frame.method === "session/prompt").params.prompt.map(part => part.type), ["image", "image", "image"]);
});

test("ACP rejects recovery-only image input when the agent lacks image capability", async () => {
  const fixture = acpFixture({ imageCapability: false });
  const adapter = createAcpAdapter({ type: "fixture", provider: "fixture", command: "fixture" }, { acpClientFactory: () => fixture.client });
  await assert.rejects(collect(adapter.invoke(invokeRequest({ providerSession: { sessionId: "old" }, freshFallbackModelInputParts: images }))), /UNSUPPORTED_INPUT_MODALITY/);
  assert.deepEqual(fixture.frames, []);
});

test("Codex real app-server identifies three native images in supplied order", { skip: process.env.OCTO_CODEX_MULTIMODAL_LIVE !== "1", timeout: 180_000 }, async () => {
  const workdir = await mkdtemp(join(tmpdir(), "octo-mm-live-"));
  try {
    const adapter = createCodexAdapter();
    const events = await collect(adapter.invoke(invokeRequest({
      workdir,
      modelInputParts: [{ type: "text", text: 'Identify the main shape and its color in each supplied image, in order. Reply with only a JSON array of three objects using keys "shape" and "color" and English lowercase values. Inspect the images directly and do not call tools.' }, ...images],
      controlInstructions: "Only answer the image question. Do not read files or run commands.",
      approvalMode: "ask",
      agentSource: "provisioned", agentConfig: { sandbox: "read-only", ...(process.env.OCTO_CODEX_MULTIMODAL_MODEL ? { model: process.env.OCTO_CODEX_MULTIMODAL_MODEL } : {}) },
      signal: AbortSignal.timeout(170_000)
    })));
    assert.equal(events.at(-1).type, "run.completed", JSON.stringify(events.at(-1)));
    const answer = events.filter(event => event.type === "message.delta" && event.payload.channel !== "analysis").map(event => event.payload.text ?? "").join("");
    const parsed = JSON.parse(answer.slice(answer.indexOf("["), answer.lastIndexOf("]") + 1));
    assert.deepEqual(parsed, [{ shape: "circle", color: "red" }, { shape: "square", color: "green" }, { shape: "triangle", color: "blue" }]);
    console.log(JSON.stringify({ evidence: "codex-native-three-image", providerSession: events.find(event => event.type === "session.update")?.payload.providerSession, images: images.map(({ sha256, byteSize }) => ({ sha256, byteSize })), answer: parsed }));
  } finally { await rm(workdir, { recursive: true, force: true }); }
});

for (const scenario of ["first", "resume", "reset", "missing-session"]) {
  test(`Codex injects mandatory instructions only at session start: ${scenario}`, async () => {
    const server = codexFixture({ fallback: scenario === "missing-session" });
    const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
    const events = await collect(adapter.invoke(invokeRequest({
      controlInstructions: "我是个人助理",
      ...(scenario === "resume" || scenario === "missing-session" ? { providerSession: { sessionId: "previous" } } : {})
    })));
    assert.equal(events.at(-1).type, "run.completed");
    const resume = server.frames.find(frame => frame.method === "thread/resume");
    if (resume) assert.equal(Object.hasOwn(resume.params, "developerInstructions"), false);
    const start = server.frames.find(frame => frame.method === "thread/start");
    if (scenario === "resume") assert.equal(start, undefined);
    else assert.equal(start.params.developerInstructions, "我是个人助理");
    assert.doesNotMatch(JSON.stringify(server.frames.find(frame => frame.method === "turn/start").params.input), /我是个人助理/);
  });
}
