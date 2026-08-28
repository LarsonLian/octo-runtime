import net from "node:net";
import { createInterface } from "node:readline";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { HarnessEngine, JsonFileStore } from "@orbtex-ai/core";
import { HarnessDaemon } from "@orbtex-ai/daemon";
import { spawnAdapterHost } from "@orbtex-ai/adapter-host";

export async function startDaemonServer({ socketPath, storePath, manifestPath, hostEntrypoint }) {
  await mkdir(dirname(socketPath), { recursive: true });
  try {
    const stat = await lstat(socketPath);
    if (!stat.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
    await rm(socketPath);
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  const store = await JsonFileStore.open(storePath);
  const hostProcess = await spawnAdapterHost({ entrypoint: hostEntrypoint, manifest: manifestPath });
  const engine = new HarnessEngine({ store, host: hostProcess.client });
  const daemon = new HarnessDaemon({ engine, store });

  const server = net.createServer(socket => {
    createInterface({ input: socket }).once("line", async line => {
      let request;
      try {
        request = JSON.parse(line);
        const result = await dispatch({ request, daemon, engine, store, host: hostProcess.client });
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ id: request?.id, error: { message: error.message, code: error.code } })}\n`);
      }
    });
  });
  try {
    await daemon.recover();
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) {
    daemon.stop(); await hostProcess.close(); await rm(socketPath, { force: true }); throw error;
  }
  return {
    server, store, daemon, engine, hostProcess,
    async close() {
      daemon.stop();
      await new Promise(resolve => server.close(resolve));
      await hostProcess.close();
      await rm(socketPath, { force: true });
    }
  };
}

async function dispatch({ request, daemon, engine, store, host }) {
  const p = request.params ?? {};
  switch (request.method) {
    case "status": return { ready: true, pid: process.pid, counts: Object.fromEntries(["agents", "triggers", "tasks", "runs"].map(name => [name, store[name].size])) };
    case "adapter.list": return host.list();
    case "adapter.probe": return host.probe(p.adapterType);
    case "agent.create": return engine.registerAgent(p);
    case "agent.list": return [...store.agents.values()];
    case "chat.create": return engine.createChatSession(p);
    case "chat.list": return [...store.sessions.values()].filter(item => item.type === "chat");
    case "chat.get": return store.sessions.get(p.sessionId) ?? null;
    case "chat.send": return daemon.submitChat(p.sessionId, p.prompt, p.instructions);
    case "trigger.create": {
      const trigger = await engine.createTrigger(p); daemon.startSchedulers(); return trigger;
    }
    case "trigger.list": return [...store.triggers.values()];
    case "trigger.fire": return daemon.submitTrigger(p.triggerId, { externalEventId: p.externalEventId, payload: p.payload });
    case "event.ingest": return daemon.ingestEvent({ eventType: p.eventType, externalEventId: p.externalEventId, payload: p.payload });
    case "task.list": return [...store.tasks.values()];
    case "task.get": return store.tasks.get(p.taskId) ?? null;
    case "task.continue": return daemon.continueTask(p.taskId, { sourceType: p.sourceType ?? "comment", sourceId: p.sourceId, instructions: p.instructions });
    case "run.get": return store.runs.get(p.runId) ?? null;
    case "run.events": return store.events.get(p.runId) ?? [];
    case "run.wait": return daemon.waitForRun(p.runId);
    case "run.cancel": return daemon.cancelRun(p.runId, p.reason);
    default: throw Object.assign(new Error(`unknown daemon method: ${request.method}`), { code: "method_not_found" });
  }
}
