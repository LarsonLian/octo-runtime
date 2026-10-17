import { createAcpAdapter } from "@mininglamp-oss/octo-runtime-adapter-acp";

export const hermesAdapter = createAcpAdapter({
  type: "hermes",
  provider: "hermes",
  command: "hermes",
  args: ["acp"],
  emptyLoadResultMeansMissing: true
});

export default hermesAdapter;
