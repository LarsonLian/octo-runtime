import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";

export const kimiCodeAdapter = createAcpAdapter({
  type: "kimi-code",
  provider: "kimi-code",
  command: "kimi",
  args: ["acp"]
});

export default kimiCodeAdapter;
