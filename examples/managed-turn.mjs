import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { AdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { createCodexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { createClaudeCodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-claude-code";

const [adapterType = "codex", mode = "native", prompt = "Reply with OK"] = process.argv.slice(2);
if (!["codex", "claude-code"].includes(adapterType) || !["native", "canonical"].includes(mode))
  throw new Error(
    "Usage: node examples/managed-turn.mjs [codex|claude-code] [native|canonical] [prompt]"
  );
const host = new AdapterHost();
host.register(adapterType === "codex" ? createCodexAdapter() : createClaudeCodeAdapter());
const controller = new AbortController();
const cancel = () => controller.abort("SIGINT");
process.once("SIGINT", cancel);
const terminal = createInterface({ input: process.stdin, output: process.stderr });
const request = {
  protocolVersion: 2,
  invocationId: randomUUID(),
  runId: randomUUID(),
  agentSessionId: randomUUID(),
  sessionGeneration: 0,
  prompt,
  modelInput: prompt,
  controlInstructions: "",
  context: { schema: "octo.context-envelope/v3", items: [] },
  approvalMode: "ask",
  agentSource: "provisioned",
  agentConfig: {},
  workdir: process.cwd(),
  signal: controller.signal
};
try {
  // The example explicitly prints the selected stream. Host debug logs omit native payloads.
  const stream =
    mode === "canonical"
      ? host.invoke(adapterType, request, { protocolMode: "canonical" })
      : host.invoke(adapterType, request);
  for await (const value of stream) {
    process.stdout.write(JSON.stringify(value) + "\n");
    if (
      mode === "native" &&
      value.kind === "control" &&
      value.control.type === "interaction" &&
      value.control.status === "pending"
    ) {
      const payload = JSON.parse(
        await terminal.question("Native response JSON: ", { signal: controller.signal })
      );
      await host.respondNative(request.invocationId, {
        requestId: value.control.requestId,
        payload
      });
    } else if (mode === "canonical" && value.type === "interaction.requested") {
      const response = JSON.parse(
        await terminal.question("Canonical response JSON: ", { signal: controller.signal })
      );
      await host.respondInteraction(request.invocationId, {
        ...response,
        interactionId: value.payload.interactionId
      });
    }
  }
} finally {
  terminal.close();
  process.off("SIGINT", cancel);
  await host.shutdown();
}
