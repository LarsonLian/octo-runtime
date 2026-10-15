import {
  OPENCLAW_RUNTIME_ROOT
} from "@mininglamp-oss/octo-runtime-adapter-openclaw";
import { configureCliOpenClaw } from "@mininglamp-oss/octo-runtime-daemon-app/openclaw";
import { defaultRuntimeHome, runtimePaths } from "./state.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnAdapterHost,
  type AdapterHostProcess
} from "@mininglamp-oss/octo-runtime-adapter-host";
import { prepareInvokeInput } from "@mininglamp-oss/octo-runtime-core";
export { prepareInvokeInput as preparePlayboard } from "@mininglamp-oss/octo-runtime-core";
import { isHostTerminal, isTerminal, invocationInput } from "@mininglamp-oss/octo-runtime-protocol";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

export interface PlayboardOptions {
  input: NodeJS.ReadableStream;
  output?: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  manifest?: string;
  runtimeRoot?: string;
}

export async function runPlayboard(options: PlayboardOptions): Promise<number> {
  if ((options.input as NodeJS.ReadStream).isTTY) {
    throw new Error(
      "playboard requires a JSON request on stdin; use <<< '...JSON...' or < request.json"
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of options.input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new TypeError("playboard request exceeds 16 MiB");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("playboard stdin must contain one complete JSON object");
  }
  const { adapterType, protocolMode, request } = prepareInvokeInput(value);
  if (adapterType === "openclaw") {
    const runtimeRoot =
      options.runtimeRoot ?? runtimePaths(defaultRuntimeHome(options.env), "default").profileRoot;
    await configureCliOpenClaw(runtimeRoot, {}, options.env);
    request.agentConfig.providerOptions = { [OPENCLAW_RUNTIME_ROOT]: runtimeRoot };
  }
  const output = options.output ?? writeLine;
  const controller = new AbortController();
  let interrupted = 0;
  const onInterrupt = (): void => {
    interrupted = 130;
    controller.abort();
  };
  const onTerminate = (): void => {
    interrupted = 143;
    controller.abort();
  };
  const onOutputError = (error: Error): void => {
    controller.abort(error);
  };
  if (!options.output) process.stdout.on("error", onOutputError);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  let host: AdapterHostProcess | undefined;
  try {
    host = await spawnAdapterHost({
      entrypoint: fileURLToPath(new URL("../../adapter-host/dist/index.js", import.meta.url)),
      manifest: options.manifest
        ? resolve(options.manifest)
        : fileURLToPath(new URL("../../../config/adapters.json", import.meta.url)),
      env: options.env ?? process.env,
      signal: controller.signal
    });
    // Host diagnostics never share the NDJSON output channel.
    const startupDiagnostics = host.stderr();
    if (startupDiagnostics) process.stderr.write(startupDiagnostics);
    host.child.stderr.on("data", (chunk: string) => process.stderr.write(chunk));
    let exitCode = 1;
    for await (const frame of host.client.invoke(
      invocationInput(request, protocolMode, adapterType),
      { signal: controller.signal }
    )) {
      await output(JSON.stringify(frame));
      if (
        ("kind" in frame &&
          frame.kind === "control" &&
          frame.control.type === "interaction" &&
          frame.control.status === "pending") ||
        (!("kind" in frame) && frame.type === "interaction.requested")
      ) {
        throw new Error(
          "PLAYBOARD_INTERACTION_REQUIRED: one-shot stdin cannot answer provider interactions"
        );
      }
      if (
        "kind" in frame &&
        isHostTerminal(frame) &&
        frame.kind === "control" &&
        frame.control.type === "state"
      ) {
        exitCode =
          frame.control.state === "completed" ? 0 : frame.control.state === "cancelled" ? 130 : 1;
      }
      if (!("kind" in frame) && isTerminal(frame))
        exitCode = frame.type === "run.completed" ? 0 : frame.type === "run.cancelled" ? 130 : 1;
    }
    return interrupted || exitCode;
  } catch (error) {
    if (interrupted) return interrupted;
    throw error;
  } finally {
    try {
      await host?.close();
    } finally {
      if (!options.output) process.stdout.removeListener("error", onOutputError);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    }
  }
}

function writeLine(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
  });
}
