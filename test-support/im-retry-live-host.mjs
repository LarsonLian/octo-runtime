import { spawn } from "node:child_process";
import {
  AdapterHost,
  AdapterHostRpcServer
} from "../packages/octo-runtime-adapter-host/dist/index.js";
import { createCodexAdapter } from "../packages/octo-runtime-adapter-codex/dist/index.js";

// 只替换本次验收第一个 Provider 进程的上游，不改用户的 config.toml 或认证文件。
let first = true;
const host = new AdapterHost();
host.register(
  createCodexAdapter({
    spawnFn(command, args, options) {
      const overrides = first
        ? [
            "-c",
            'model_provider="octo_retry_live"',
            "-c",
            'model_providers.octo_retry_live.name="Octo retry live fault"',
            "-c",
            `model_providers.octo_retry_live.base_url="${process.env.OCTO_RETRY_FAULT_URL}"`,
            "-c",
            'model_providers.octo_retry_live.wire_api="responses"',
            "-c",
            "model_providers.octo_retry_live.requires_openai_auth=false",
            "-c",
            "model_providers.octo_retry_live.request_max_retries=0",
            "-c",
            "model_providers.octo_retry_live.stream_max_retries=0"
          ]
        : [];
      let spawnOptions = options;
      if (first) {
        const env = {
          ...options.env,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost"
        };
        for (const name of [
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "ALL_PROXY",
          "http_proxy",
          "https_proxy",
          "all_proxy"
        ])
          delete env[name];
        spawnOptions = { ...options, env };
      }
      first = false;
      return spawn(command, [...args, ...overrides], spawnOptions);
    }
  })
);
new AdapterHostRpcServer({ host, output: process.stdout }).listen(process.stdin);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void host.shutdown().then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
process.stdin.once("end", stop);
process.stdin.once("close", stop);
