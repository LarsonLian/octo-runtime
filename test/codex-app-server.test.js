import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";

const fixture = fileURLToPath(new URL("../test-support/fake-codex-cancellation.mjs", import.meta.url));

test("Codex reports scoped activity before normalization without retry/duplicate progress", async () => {
  const adapter = createCodexAdapter({ command:process.execPath, appServerArgs:[fileURLToPath(new URL("../test-support/fake-codex-activity.mjs",import.meta.url))] });
  const activities=[]; const events=[];
  for await(const event of adapter.invoke({ protocolVersion: 2,invocationId:"i",agentSessionId:"s",runId:"r",prompt:"p",workdir:process.cwd(),agentConfig:{}}, {
    observe:async()=>({captureId:"off",state:"disabled",complete:false}), reportActivity:a=>activities.push(a)
  })) events.push(event);
  assert.equal(activities.filter(a=>a.kind==="turn_progress" && a.method==="text_delta").length,1);
  assert.equal(activities.filter(a=>a.method==="usage").length,1);
  assert.equal(activities.filter(a=>a.method==="item_lifecycle").length,1);
  assert.equal(activities.filter(a=>a.kind==="retry_notice").length,1);
  assert.ok(activities.some(a=>a.kind==="transport_response"));
  assert.doesNotMatch(JSON.stringify(activities),/secret|noise|not ours|not current|ok/);
  assert.doesNotMatch(JSON.stringify(events),/not ours|not current/);
  assert.equal(events.at(-1).type,"run.completed");
});

test("Codex cancellation reaps the whole app-server process group", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-codex-cancel-"));
  const pidFile = join(directory, "grandchild.pid");
  const controller = new AbortController();
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const events = [];

  for await (const event of adapter.invoke({ protocolVersion: 2,
    invocationId: "invoke-cancel-tree",
    agentSessionId: "session-cancel-tree",
    runId: "run-cancel-tree",
    prompt: `WAIT_FOR_CANCEL PID_FILE=${pidFile}`,
    workdir: process.cwd(),
    context: {},
    appendInstructions: "",
    agentConfig: {},
    signal: controller.signal
  })) {
    events.push(event);
    if (event.type === "message.delta") controller.abort("test_cancel");
  }

  assert.equal(events.at(-1).type, "run.cancelled");
  const grandchildPid = Number(await readFile(pidFile, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchildPid, 0), error => error?.code === "ESRCH");
});
