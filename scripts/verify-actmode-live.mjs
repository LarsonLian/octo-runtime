import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";
import codex from "../packages/octo-runtime-adapter-codex/dist/index.js";
import claude from "../packages/octo-runtime-adapter-claude-code/dist/index.js";
import kimi from "../packages/octo-runtime-adapter-kimi-code/dist/index.js";
import opencode from "../packages/octo-runtime-adapter-opencode/dist/index.js";
import mcode from "../packages/octo-runtime-adapter-mcode/dist/index.js";

// 测试调用方显式选择模式与续接；不让 Runtime 决定产品策略。
const host = new AdapterHost();
for (const adapter of [codex, claude, kimi, opencode, mcode]) host.register(adapter);
const workdir = await mkdtemp(join(tmpdir(), "octo-actmode-live-"));
const results = [];
for (const type of (process.env.OCTO_ACTMODE_PROVIDERS ?? "codex,claude-code,opencode").split(",")) {
  let providerSession;
  for (const mode of ["plan", "default", undefined]) {
    const runId = `actmode_${randomUUID()}`;
    const result = { type, mode: mode ?? "omitted", runId, resumed: Boolean(providerSession), evidence: [], text: "" };
    try {
      for await (const event of host.invoke({
        inputs: [{ type: "text", text: "This is an execution protocol test. Reply exactly MODE_PASS. Do not use any tools, create a plan file, change files, or run commands." }],
        contexts: { schema: "octo.context-envelope/v3", items: [
          { namespace: "octo.execution", name: "adapter", payload: { type } },
          { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: workdir } },
          ...(type === "claude-code" && process.env.OCTO_ACTMODE_CC_MODEL ? [{ namespace: "octo.execution", name: "model", payload: { selection: { id: process.env.OCTO_ACTMODE_CC_MODEL } } }] : []),
          ...(mode ? [{ namespace: "octo.execution", name: "actmode", payload: { mode } }] : [])
        ] },
        protocol_mode: "canonical", runId,
        ...(providerSession ? { providerSession, continuityMode: "continue" } : {})
      }, { signal: AbortSignal.timeout(120000) })) {
        if (event.type === "execution.update") result.evidence.push(event.payload.actmode);
        if (event.type === "session.update" && event.payload.providerSession) providerSession = event.payload.providerSession;
        if (event.type === "message.delta" && event.payload.channel !== "analysis") result.text += event.payload.text ?? "";
        if (event.type === "interaction.requested") throw new Error("Unexpected interaction in tool-free mode test");
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
          result.terminal = event.type;
          if (event.type !== "run.completed") result.failure = { code: event.payload.code, message: event.payload.message };
        }
      }
      result.providerSessionId = providerSession?.sessionId;
      assert.equal(result.terminal, "run.completed", JSON.stringify(result.failure));
      assert.match(result.text, /MODE_PASS/);
      if (mode) {
        assert.equal(result.evidence.length, 1);
        assert.equal(result.evidence[0].effective, mode);
        assert.equal(result.evidence[0].status, "applied");
      } else assert.equal(result.evidence.length, 0);
      result.passed = true;
    } catch (error) {
      result.passed = false;
      result.error = error.message;
    }
    results.push(result);
    console.log(JSON.stringify(result));
    if (!result.passed) break;
  }
}
const output = resolve(".octospec/tasks/adapter-plan-interaction-exploration/live-results.json");
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify({workdir,results}, null, 2)}\n`);
assert.ok(results.every(result => result.passed), "One or more real Provider cases failed; inspect recorded results");
