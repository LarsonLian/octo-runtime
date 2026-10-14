import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { invokeRequest } from "./runtime-fixture.js";

test("real Codex finalization interruption preserves the answer and resumes the thread", {
  skip: process.env.OCTO_CODEX_FINALIZATION_LIVE !== "1", timeout: 180_000
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-codex-finalization-live-"));
  const adapter = createCodexAdapter();
  const run = async (input, providerSession, timeoutMs) => {
    const events = [];
    const started = Date.now();
    for await (const event of adapter.invoke(invokeRequest({ modelInput: input, prompt: input,
      workdir: directory, providerSession,
      signal: AbortSignal.timeout(80_000), controlInstructions: "Answer the question directly. Do not call tools.",
      agentConfig: { providerOptions: { finalizationTimeoutMs: timeoutMs } }
    }))) events.push(event);
    console.log(JSON.stringify({ elapsedMs: Date.now() - started, terminal: events.at(-1),
      answer: events.filter(event => event.type === "message.update" && event.payload.channel === "final").map(event => event.payload.text) }));
    return events;
  };
  try {
    const first = await run("Remember the marker OCTO_FINALIZATION_RESUME. Reply with only that marker.", undefined, 1);
    assert.ok(first.some(event => event.type === "message.update" && event.payload.text?.includes("OCTO_FINALIZATION_RESUME")));
    assert.ok(["run.completed", "run.failed"].includes(first.at(-1).type));
    if (first.at(-1).type === "run.failed") assert.equal(first.at(-1).payload.code, "CODEX_FINALIZATION_TIMEOUT");
    const session = first.find(event => event.type === "session.update")?.payload.providerSession;
    assert.ok(session?.sessionId);
    const second = await run("What marker did I ask you to remember? Reply with only the marker.", session, 15_000);
    assert.equal(second.at(-1).type, "run.completed");
    assert.ok(second.some(event => event.type === "session.update" && event.payload.providerSession?.resumeOutcome === "resumed"));
    assert.ok(second.some(event => event.type === "message.update" && event.payload.text?.includes("OCTO_FINALIZATION_RESUME")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
