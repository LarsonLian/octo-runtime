#!/usr/bin/env node

const adapterType = process.argv[2];
const adapters = {
  hermes: async () => (await import("@mininglamp-oss/octo-harness-adapter-hermes")).hermesAdapter,
  "kimi-code": async () => (await import("@mininglamp-oss/octo-harness-adapter-kimi-code")).kimiCodeAdapter
};

if (!adapters[adapterType]) {
  console.error("usage: node scripts/acp-smoke.mjs <hermes|kimi-code>");
  process.exit(2);
}

const adapter = await adapters[adapterType]();
const controller = new AbortController();
const timeoutMs = Number(process.env.ACP_SMOKE_TIMEOUT_MS ?? 120_000);
const timeout = setTimeout(() => controller.abort("smoke_timeout"), timeoutMs);
const startedAt = Date.now();
const events = [];
const expectedText = `${adapterType.toUpperCase().replaceAll("-", "_")}_E2E_OK`;
let finalText = "";

try {
  for await (const event of adapter.invoke({
    invocationId: `${adapterType}-smoke`,
    agentSessionId: `${adapterType}-smoke-session`,
    runId: `${adapterType}-smoke-run`,
    prompt: `Reply with exactly ${expectedText} and nothing else.`,
    workdir: process.cwd(),
    context: {},
    appendInstructions: "Follow the requested output format exactly.",
    agentConfig: { autoApprove: true },
    signal: controller.signal
  })) {
    events.push(event);
    if (event.type === "message.delta" && (event.payload.channel ?? "final") === "final") {
      finalText += typeof event.payload.text === "string" ? event.payload.text : "";
    }
    if (event.type === "message.update"
      && (event.payload.channel ?? "final") === "final"
      && typeof event.payload.text === "string") {
      finalText = event.payload.text;
    }
    const text = typeof event.payload?.text === "string" ? event.payload.text.slice(0, 200) : undefined;
    console.log(JSON.stringify({ elapsedMs: Date.now() - startedAt, type: event.type, ...(text ? { text } : {}) }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}

if (events.at(-1)?.type !== "run.finished" || finalText.trim() !== expectedText) {
  console.error(`ACP smoke failed: terminal=${events.at(-1)?.type ?? "none"} final=${JSON.stringify(finalText.trim())}`);
  process.exitCode = 1;
}
