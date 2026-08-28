#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { startDaemonServer } from "./server.js";

function option(name, fallback) {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback;
}
const home = resolve(process.env.ORBTEX_HOME ?? ".orbtex");
const app = await startDaemonServer({
  socketPath: resolve(option("--socket", `${home}/daemon.sock`)),
  storePath: resolve(option("--store", `${home}/state.json`)),
  manifestPath: resolve(option("--manifest", fileURLToPath(new URL("../../../config/adapters.json", import.meta.url)))),
  hostEntrypoint: resolve(option("--host-entrypoint", fileURLToPath(new URL("../../adapter-host/src/index.js", import.meta.url))))
});
console.error(`orbtex daemon ready pid=${process.pid}`);
const stop = async () => { await app.close(); process.exit(0); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
