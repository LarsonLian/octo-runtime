#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { startDaemonServer } from "./server.js";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback;
}
const home = resolve(process.env.ORBTEX_HOME ?? ".orbtex");
const app = await startDaemonServer({
  socketPath: resolve(option("--socket", `${home}/daemon.sock`)),
  storePath: resolve(option("--store", `${home}/state.json`)),
  manifestPath: resolve(option("--manifest", fileURLToPath(new URL("../../../config/adapters.json", import.meta.url)))),
  hostEntrypoint: resolve(option("--host-entrypoint", fileURLToPath(new URL("../../adapter-host/dist/index.js", import.meta.url))))
});
console.error(`orbtex daemon ready pid=${process.pid}`);
const stop = (): void => {
  // signal handler 必须立即返回；实际清理仍由同一个 Promise 串行完成。
  void app.close().then(
    () => process.exit(0),
    error => {
      console.error(`orbtex daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  );
};
process.once("SIGINT", stop); process.once("SIGTERM", stop);
