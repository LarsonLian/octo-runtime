import { AdapterHost } from "@orbtex-ai/orbtex-adapter-host";
import { codexAdapter } from "@orbtex-ai/orbtex-adapter-codex";
import { HarnessEngine, MemoryStore } from "@orbtex-ai/orbtex-core";

const host = new AdapterHost();
host.register(codexAdapter);
const store = new MemoryStore();
const engine = new HarnessEngine({ store, host });
const agent = await engine.registerAgent({
  name: "demo",
  adapterType: "codex",
  config: { workdir: process.cwd(), sandbox: "read-only" }
});
const trigger = await engine.createTrigger({
  name: "manual-demo", kind: "manual", agentId: agent.id,
  task: { title: "Inspect repository", description: "Summarize the current repository." }
});
const output = await engine.fire(trigger.id, { externalEventId: "demo-1", payload: { source: "cli" } });
console.log(JSON.stringify(output, null, 2));
