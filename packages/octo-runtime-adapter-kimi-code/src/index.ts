import { createAcpAdapter } from "@mininglamp-oss/octo-runtime-adapter-acp";

export const kimiCodeAdapter = createAcpAdapter({
  type: "kimi-code",
  provider: "kimi-code",
  command: "kimi",
  args: ["acp"]
});

export default kimiCodeAdapter;
