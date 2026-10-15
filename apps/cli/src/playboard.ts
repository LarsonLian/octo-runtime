import { defaultRuntimeHome, runtimePaths } from "./state.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startTemporaryDaemon } from "./temporary-daemon.js";
import { invokeDaemonRun } from "@mininglamp-oss/octo-runtime-daemon/runtime/run-stream";
import { type InvokeInput, identifyInvokeInput, createInputInvoke, isHostTerminal, isTerminal } from "@mininglamp-oss/octo-runtime-protocol";

import { INVOKE_REQUEST_MAX_BYTES } from "@mininglamp-oss/octo-runtime-protocol";

export interface PlayboardOptions {
  input: NodeJS.ReadableStream;
  output?: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  manifest?: string;
  home?: string;
  profile?: string;
}

export async function runPlayboard(options: PlayboardOptions): Promise<number> {
  if ((options.input as NodeJS.ReadStream).isTTY) {
    throw new Error(
      "playboard requires a JSON request on stdin; use <<< '...JSON...' or < request.json"
    );
  }
  let body = Buffer.alloc(0);
  let size = 0;
  for await (const chunk of options.input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextSize = size + bytes.length;
    if (nextSize > INVOKE_REQUEST_MAX_BYTES) throw new TypeError("INVOKE_REQUEST_TOO_LARGE");
    if (nextSize > body.length) {
      const expanded = Buffer.allocUnsafe(Math.min(INVOKE_REQUEST_MAX_BYTES, Math.max(65536, body.length * 2, nextSize)));
      body.copy(expanded, 0, 0, size);
      body = expanded;
    }
    bytes.copy(body, size);
    size = nextSize;
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8", 0, size));
    body = Buffer.alloc(0);
  } catch {
    throw new TypeError("playboard stdin must contain one complete JSON object");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("playboard stdin must contain one JSON input object");
  const input = identifyInvokeInput(value as InvokeInput);
  const profile = options.profile ?? "default";
  const home = options.home ?? defaultRuntimeHome(options.env);
  runtimePaths(home, profile); // Validate the selected profile before starting resources.
  if (input.runMetadata?.profile !== undefined && input.runMetadata.profile !== profile)
    throw new Error("RUNTIME_CONFIGURATION_NOT_FOUND: request profile differs from --profile");
  input.runMetadata = { ...input.runMetadata, profile };
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
  let daemon: Awaited<ReturnType<typeof startTemporaryDaemon>> | undefined;
  try {
    daemon = await startTemporaryDaemon({
      home,
      profile,
      manifest: options.manifest
        ? resolve(options.manifest)
        : fileURLToPath(new URL("../../../config/adapters.json", import.meta.url)),
      env: options.env ?? process.env,
      signal: controller.signal
    });
    const socket = daemon.socket;
    const invoke = createInputInvoke((input, environment) =>
      invokeDaemonRun(socket, input, environment)
    );
    let exitCode = 1;
    for await (const frame of invoke(
      input,
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
      await daemon?.close();
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
