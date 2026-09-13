import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";

export const hermesAdapter = createAcpAdapter({
  type: "hermes",
  provider: "hermes",
  command: "hermes",
  args: ["acp"],
  emptyLoadResultMeansMissing: true
});

export default hermesAdapter;
