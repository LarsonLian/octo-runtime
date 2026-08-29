import { AdapterHost } from "@orbtex-ai/orbtex-adapter-host";
import { HarnessEngine, MemoryStore } from "@orbtex-ai/orbtex-core";
import { mockAdapter } from "@orbtex-ai/orbtex-adapter-mock";

const host = new AdapterHost();
host.register(mockAdapter);
const store = new MemoryStore();
const engine = new HarnessEngine({ store, host });
const agent = await engine.registerAgent({ name: "demo", adapterType: "mock", config: { workdir: process.cwd() } });
const trigger = await engine.createTrigger({
  name: "manual-demo", kind: "manual", agentId: agent.id,
  task: { title: "Inspect repository", description: "Summarize the current repository." }
});
const output = await engine.fire(trigger.id, { externalEventId: "demo-1", payload: { source: "cli" } });
console.log(JSON.stringify(output, null, 2));
