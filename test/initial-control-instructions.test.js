import test from "node:test";
import assert from "node:assert/strict";
import { buildClaudeCommand } from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { buildOpenCodeCommand } from "@mininglamp-oss/octo-runtime-adapter-opencode";
import { readFile } from "node:fs/promises";
import { invokeRequest } from "./agent-work-runtime-fixture.js";

for (const resumed of [false, true]) {
  test(`Claude system prompt is injected only on first run: resumed=${resumed}`, async () => {
    const command = await buildClaudeCommand(invokeRequest({ controlInstructions: "我是个人助理", ...(resumed ? { providerSession: { sessionId: "session" } } : {}) }));
    try {
      const index = command.args.indexOf("--append-system-prompt-file");
      if (resumed) assert.equal(index, -1);
      else assert.equal(await readFile(command.args[index + 1], "utf8"), "我是个人助理");
      assert.doesNotMatch(command.input, /我是个人助理/);
    } finally { await command.cleanup(); }
  });
}

for (const resumed of [false, true]) {
  test(`OpenCode does not append system instructions on resume: resumed=${resumed}`, async () => {
    const command = await buildOpenCodeCommand(invokeRequest({ approvalMode: "full_access", controlInstructions: "我是个人助理", ...(resumed ? { providerSession: { sessionId: "session" } } : {}) }));
    try {
      const config = JSON.parse(command.env.OPENCODE_CONFIG_CONTENT);
      if (resumed) assert.equal(config.instructions, undefined);
      else assert.equal(await readFile(config.instructions[0], "utf8"), "我是个人助理");
    } finally { await command.cleanup(); }
  });
}
