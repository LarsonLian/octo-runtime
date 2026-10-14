import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ExtraPlugins, readExtraDirectory } from "../packages/octo-runtime-daemon/dist/index.js";
import { createInputInvoke } from "../packages/octo-runtime-core/dist/index.js";
import { invokeDaemonRun } from "../packages/octo-runtime-daemon/dist/runtime/run-stream.js";
import { callDaemon } from "../packages/octo-runtime-daemon/dist/runtime/runtime-contract.js";
import { runCli } from "../apps/cli/dist/main.js";

// Read only public renderer state; no login, runtime or enrollment token is logged.
const tabs = await fetch("http://127.0.0.1:9222/json/list").then((response) => response.json());
const page = tabs.find((tab) => tab.type === "page" && tab.url.includes("localhost"));
assert.ok(page, "Real Work App renderer required");
const ws = new WebSocket(page.webSocketDebuggerUrl);
const environment = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    ws.close();
    reject(new Error("CDP timeout"));
  }, 15000);
  ws.addEventListener(
    "error",
    () => {
      clearTimeout(timer);
      reject(new Error("CDP unavailable"));
    },
    { once: true }
  );
  ws.addEventListener("open", () =>
    ws.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression:
            "(async()=>{const c=await window.octoWork.getConfig(),s=await window.octoWork.restoreSession(),r=await window.octoWork.getEmbeddedRuntimeStatus();return {server:c.serverUrl,loggedIn:s.loggedIn,daemonPid:r.daemonPid,phase:r.phase,connectionsEnabled:r.connectionsEnabled}})()",
          awaitPromise: true,
          returnByValue: true
        }
      })
    )
  );
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    ws.close();
    if (message.error || message.result.exceptionDetails)
      reject(new Error("Renderer probe failed"));
    else resolve(message.result.result.value);
  });
});
assert.equal(environment.server, "https://im-test.deepminer.com.cn");
assert.equal(environment.loggedIn, true);
assert.equal(environment.phase, "running");
const runtimeHome =
  process.env.OCTO_EXTRA_LIVE_RUNTIME_HOME ?? join(homedir(), ".octo-runtime-work");
const socket = join(runtimeHome, "sockets", "octo-runtime-daemon.sock");
const status = await callDaemon(socket, { method: "status" });
assert.equal(status.pid, environment.daemonPid);
assert.equal(status.ready, true);

const home = await mkdtemp(join(tmpdir(), "octo-extra-live-"));
const token = randomUUID();
const port = Number(process.env.OCTO_EXTRA_LIVE_PORT ?? 3002);
let extras;
try {
  await runCli(["--home", home, "extraset", "sse-demo"], {
    input: Readable.from([
      JSON.stringify({
        module: "@mininglamp-oss/octo-runtime-extra-sse-demo",
        config: { host: "127.0.0.1", port, token }
      })
    ]),
    output() {}
  });
  // Inject the real desktop daemon's IPC execution port, rather than a mock Provider.
  extras = new ExtraPlugins(await readExtraDirectory(join(home, "default/extra")), {
    invoke: createInputInvoke((type, request, options) =>
      invokeDaemonRun(socket, type, request, options)
    )
  });
  await extras.loadConfigured();
  assert.equal(extras.status["sse-demo"].phase, "loaded");
  const endpoint = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(endpoint, { method: "POST", body: "{}" })).status, 401);
  const marker = `EXTRA_SSE_${randomUUID().slice(0, 8)}`;
  const prompt = `Reply exactly ${marker}. Do not call tools.`;
  const request = {
    protocolVersion: 2,
    invocationId: randomUUID(),
    runId: randomUUID(),
    agentSessionId: randomUUID(),
    sessionGeneration: 0,
    agentSource: "provisioned",
    prompt,
    modelInput: prompt,
    controlInstructions: "",
    workdir: process.cwd(),
    context: { schema: "octo.context-envelope/v3", items: [] },
    approvalMode: "full_access",
    agentConfig: {}
  };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      inputs: [{ type: "text", text: prompt }],
      contexts: { schema: "octo.context-envelope/v3", items: [{ namespace: "octo.execution", name: "adapter", payload: { type: "codex" } }] },
      sessionId: request.agentSessionId,
      protocol_mode: "canonical",
      approvalMode: "full_access"
    }),
    signal: AbortSignal.timeout(90000)
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  assert.doesNotMatch(text, /event: error/);
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.slice("data: ".length)));
  assert.ok(events.some((event) => event.type === "run.completed"));
  const answer = events
    .filter((event) => event.type === "message.delta" && event.payload.channel === "final")
    .map((event) => event.payload.text ?? "")
    .join("");
  assert.equal(answer.trim(), marker);
  await extras.unload("sse-demo");
  await assert.rejects(fetch(endpoint));
  assert.equal((await callDaemon(socket, { method: "status" })).ready, true);
  console.log(
    JSON.stringify({
      passed: true,
      server: environment.server,
      rendererDaemonPid: status.pid,
      connectionsEnabled: environment.connectionsEnabled,
      provider: "codex",
      port,
      runId: request.runId,
      terminal: "run.completed",
      bearerRejected: true,
      unloadedPortClosed: true,
      sharedHostStillReady: true
    })
  );
} finally {
  await extras?.close();
  await rm(home, { recursive: true, force: true });
}
