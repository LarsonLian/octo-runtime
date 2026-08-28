import { spawn } from "node:child_process";
import { AdapterHostRpcClient } from "./rpc.js";

export async function spawnAdapterHost({ entrypoint, manifest, env = process.env }) {
  const child = spawn(process.execPath, [entrypoint, "--manifest", manifest], {
    env, stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", value => { stderr = (stderr + value).slice(-8192); });
  const client = new AdapterHostRpcClient({ input: child.stdout, output: child.stdin });
  try { await client.list(); }
  catch (error) { child.kill(); throw new Error(`${error.message}${stderr ? `: ${stderr}` : ""}`); }
  return {
    client, child,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
    stderr: () => stderr
  };
}
