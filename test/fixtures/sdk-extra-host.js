import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { createCodexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { fileURLToPath } from "node:url";
import { testAdapter } from "./test-adapter.js";

serveAdapterHost([
  {
    ...testAdapter,
    async *invoke(request) {
      if (request.prompt !== "inspect-input") return yield* testAdapter.invoke(request);
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: {
          text: JSON.stringify({
            context: request.context,
            executionEnvOverrides: request.executionEnvOverrides,
            pid: process.pid
          })
        }
      };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  },
  createCodexAdapter({
    command: process.execPath,
    appServerArgs: [
      fileURLToPath(new URL("../../test-support/fake-native-codex.mjs", import.meta.url))
    ]
  })
]);
