import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";
import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";
import { acpPromptParams } from "@mininglamp-oss/octo-harness-acp-client";
import { invokeRequest } from "./agent-work-runtime-fixture.js";
import { visualInputImages } from "../test-support/multimodal-images.mjs";

const images = visualInputImages();
const mixed = [{ type: "text", text: "first" }, images[0], { type: "text", text: "second" }, images[1]];
const collect = async iterable => { const events = []; for await (const event of iterable) events.push(event); return events; };
const observer = observations => ({ observe: async observation => { observations.push(observation); return { captureId: "off", state: "disabled", complete: false }; } });

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
    const observations = [];
    const events = await collect(adapter.invoke(invokeRequest({
      modelInputParts: fallback ? [{ type: "text", text: "delta" }, images[1]] : mixed,
      ...(fallback ? { providerSession: { sessionId: "missing" }, freshFallbackModelInputParts: mixed } : {})
    }), observer(observations)));
    const input = server.frames.find(frame => frame.method === "turn/start").params.input;
    assert.deepEqual(input, mixed.map(part => part.type === "image" ? { type: "image", url: `data:${part.mimeType};base64,${part.data}` } : { type: "text", text: part.text, text_elements: [] }));
    assert.equal(events.at(-1).type, "run.completed");
    if (fallback) assert.equal(events.find(event => event.type === "session.update").payload.providerSession.contextInputVariant, "recovery");
    const capture = observations.find(value => value.rpcMethod === "turn/start" && value.event === "provider.input");
    assert.equal(capture.carrier.content.params.input[1].sha256, images[0].sha256);
    assert.equal(capture.carrier.content.params.input[1].byteSize, images[0].byteSize);
    for (const image of images) assert.equal(JSON.stringify(observations).includes(image.data), false);
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
    const observations = [];
    const events = await collect(adapter.invoke(invokeRequest({ modelInputParts: mixed, controlInstructions: "CONTROL", ...(fallback ? { providerSession: { sessionId: "missing" }, freshFallbackModelInputParts: [...mixed, images[2]] } : {}) }), observer(observations)));
    const expected = [...mixed, ...(fallback ? [images[2]] : []), { type: "text", text: "CONTROL" }];
    assert.deepEqual(fixture.frames.find(frame => frame.method === "session/prompt").params, acpPromptParams("acp-fixture", expected));
    assert.equal(events.at(-1).type, "run.completed");
    const capture = observations.find(value => value.rpcMethod === "session/prompt" && value.event === "provider.input");
    assert.equal(capture.carrier.content.params.prompt[1].sha256, images[0].sha256);
    assert.equal(capture.carrier.content.params.prompt[1].byteSize, images[0].byteSize);
    for (const image of images) assert.equal(JSON.stringify(observations).includes(image.data), false);
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
  const observations = [];
  try {
    const adapter = createCodexAdapter();
    const events = await collect(adapter.invoke(invokeRequest({
      workdir,
      modelInputParts: [{ type: "text", text: 'Identify the main shape and its color in each supplied image, in order. Reply with only a JSON array of three objects using keys "shape" and "color" and English lowercase values. Inspect the images directly and do not call tools.' }, ...images],
      controlInstructions: "Only answer the image question. Do not read files or run commands.",
      approvalMode: "ask",
      agentSource: "provisioned", agentConfig: { sandbox: "read-only", ...(process.env.OCTO_CODEX_MULTIMODAL_MODEL ? { model: process.env.OCTO_CODEX_MULTIMODAL_MODEL } : {}) },
      signal: AbortSignal.timeout(170_000)
    }), observer(observations)));
    assert.equal(events.at(-1).type, "run.completed", JSON.stringify(events.at(-1)));
    const answer = events.filter(event => event.type === "message.delta" && event.payload.channel !== "analysis").map(event => event.payload.text ?? "").join("");
    const parsed = JSON.parse(answer.slice(answer.indexOf("["), answer.lastIndexOf("]") + 1));
    assert.deepEqual(parsed, [{ shape: "circle", color: "red" }, { shape: "square", color: "green" }, { shape: "triangle", color: "blue" }]);
    const input = observations.find(value => value.event === "provider.input" && value.rpcMethod === "turn/start").carrier.content.params.input;
    assert.deepEqual(input.filter(part => part.type === "image").map(part => part.sha256), images.map(image => image.sha256));
    console.log(JSON.stringify({ evidence: "codex-native-three-image", providerSession: events.find(event => event.type === "session.update")?.payload.providerSession, images: images.map(({ sha256, byteSize }) => ({ sha256, byteSize })), answer: parsed }));
  } finally { await rm(workdir, { recursive: true, force: true }); }
});
