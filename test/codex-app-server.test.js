import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";

const fixture = fileURLToPath(new URL("../test-support/fake-codex-cancellation.mjs", import.meta.url));

test("Codex cancellation reaps the whole app-server process group", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "octo-codex-cancel-"));
  const pidFile = join(directory, "grandchild.pid");
  const controller = new AbortController();
  const adapter = createCodexAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const events = [];

  for await (const event of adapter.invoke({
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

  assert.equal(events.at(-1).type, "run.stopped");
  const grandchildPid = Number(await readFile(pidFile, "utf8"));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchildPid, 0), error => error?.code === "ESRCH");
});
