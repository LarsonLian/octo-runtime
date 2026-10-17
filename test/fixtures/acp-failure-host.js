import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { createAcpAdapter } from "@mininglamp-oss/octo-runtime-adapter-acp";

serveAdapterHost([
  createAcpAdapter({ type: "broken-acp", provider: "fixture", command: "/octo-missing-R05" }),
  {
    metadata: {
      type: "healthy",
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "healthy.canonical", modes: ["canonical"], nativeMethods: [] }
    },
    async *invoke() {
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: { text: "started", channel: "final" }
      };
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  }
]);
