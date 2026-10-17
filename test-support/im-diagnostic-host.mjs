import { fileURLToPath } from "node:url";
import {
  AdapterHost,
  AdapterHostRpcServer
} from "../packages/octo-runtime-adapter-host/dist/index.js";
import { createCodexAdapter } from "../packages/octo-runtime-adapter-codex/dist/index.js";

const host = new AdapterHost();
host.register(
  createCodexAdapter({
    command: process.execPath,
    appServerArgs: [fileURLToPath(new URL("./fake-codex-diagnostics.mjs", import.meta.url))]
  })
);
new AdapterHostRpcServer({ host, output: process.stdout }).listen(process.stdin);
const stop = () => {
  void host.shutdown().finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdin.once("end", stop);
