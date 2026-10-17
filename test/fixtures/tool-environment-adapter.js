import { execFileSync } from "node:child_process";
import { invocationEnvironment } from "../../packages/octo-runtime-adapter-sdk/dist/index.js";

export const adapter = {
  metadata: {
    type: "tool-env",
    protocolSupport: { protocol: "tool-env.canonical", modes: ["canonical"], nativeMethods: [] },
    agentSources: ["provisioned"]
  },
  async *invoke(request) {
    const env = invocationEnvironment(request);
    const result = execFileSync(
      process.execPath,
      [
        "-e",
        `process.stdout.write(JSON.stringify({
      tokenMatches: process.env.OCTO_BOT_TOKEN === process.env.EXPECTED_TOKEN,
      baseMatches: process.env.OCTO_API_BASE_URL === 'https://im-test.deepminer.com.cn',
      extraKept: process.env.EXTRA_TOOL_VALUE === 'kept'
    }))`
      ],
      { env, encoding: "utf8" }
    );
    yield {
      protocolVersion: 2,
      type: "message.create",
      payload: { role: "assistant", status: "streaming" }
    };
    yield {
      protocolVersion: 2,
      type: "message.update",
      payload: { role: "assistant", status: "completed", text: result }
    };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  }
};
