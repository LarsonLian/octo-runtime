import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";

export const kiroAdapter = createAcpAdapter({
  type: "kiro",
  provider: "kiro",
  command: "kiro-cli",
  args: ["acp"]
});

export default kiroAdapter;
