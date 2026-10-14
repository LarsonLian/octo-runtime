import { configureOpenClawConnection, OPENCLAW_RUNTIME_ROOT } from "@mininglamp-oss/octo-runtime-adapter-openclaw";
import { defaultRuntimeHome, runtimePaths } from "./state.js";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  spawnAdapterHost,
  type AdapterHostProcess
} from "@mininglamp-oss/octo-runtime-adapter-host";
import { localRuntimeLimits, resolveLocalContext } from "@mininglamp-oss/octo-runtime-core";
import {
  CONTEXT_SCHEMA,
  assertAgentSource,
  assertContextEnvelope,
  assertInvokeRequest,
  assertModelInputParts,
  contextControlInstructions,
  contextItem,
  isHostTerminal,
  mergeContext,
  type ContextEnvelope,
  type InvokeRequest,
  type ProviderSession
} from "@mininglamp-oss/octo-runtime-protocol";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** CLI shorthand resolves execution defaults before entering the strict Context contract. */
function playboardContext(value: unknown): ContextEnvelope {
  if (isRecord(value) && Array.isArray(value.items)) {
    value = {
      ...value,
      items: value.items.map((item: unknown) => {
        if (
          isRecord(item) &&
          item.namespace === "octo.execution" &&
          item.name === "adapter" &&
          isRecord(item.payload) &&
          item.payload.type === "openclaw" &&
          !Object.hasOwn(item.payload, "provider_agent_id")
        ) {
          return { ...item, payload: { ...item.payload, provider_agent_id: "main" } };
        }
        return item;
      })
    };
  }
  assertContextEnvelope(value);
  return value;
}

export interface PlayboardOptions {
  input: NodeJS.ReadableStream;
  output?: (line: string) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  manifest?: string;
  runtimeRoot?: string;
}

/** One caller-owned snapshot, with no persistent session or daemon state. */
export function preparePlayboard(value: unknown): {
  adapterType: string;
  protocolMode: "native" | "canonical";
  request: InvokeRequest;
} {
  if (!isRecord(value)) throw new TypeError("playboard request must be a JSON object");
  const fields = [
    "inputs",
    "contexts",
    "sessionId",
    "protocol_mode",
    "agentSource",
    "providerSession",
    "continuityMode"
  ];
  if (Object.keys(value).some((key) => !fields.includes(key))) {
    throw new TypeError(`playboard request accepts only: ${fields.join(", ")}`);
  }
  assertModelInputParts(value.inputs);
  const contexts = playboardContext(value.contexts);
  const protocolMode = value.protocol_mode ?? "native";
  if (protocolMode !== "native" && protocolMode !== "canonical") {
    throw new TypeError("protocol_mode must be native or canonical");
  }
  const adapterType = contextItem(contexts, "octo.execution", "adapter")?.payload.type;
  const agentSource = value.agentSource ?? (adapterType === "openclaw" ? "preset" : "provisioned");
  assertAgentSource(agentSource);
  if (
    value.sessionId !== undefined &&
    (typeof value.sessionId !== "string" || !value.sessionId.trim())
  ) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  const continuityMode = value.continuityMode ?? (value.providerSession ? "continue" : "fresh");
  if (continuityMode !== "fresh" && continuityMode !== "continue") {
    throw new TypeError("continuityMode must be fresh or continue");
  }
  let providerSession: ProviderSession | undefined;
  if (value.providerSession !== undefined) {
    if (
      !isRecord(value.providerSession) ||
      typeof value.providerSession.sessionId !== "string" ||
      !value.providerSession.sessionId.trim()
    ) {
      throw new TypeError("providerSession.sessionId must be a non-empty string");
    }
    if (
      value.providerSession.resumable !== undefined &&
      typeof value.providerSession.resumable !== "boolean"
    ) {
      throw new TypeError("providerSession.resumable must be a boolean");
    }
    providerSession = structuredClone(value.providerSession) as ProviderSession;
  }
  if (continuityMode === "fresh" && providerSession)
    throw new TypeError("fresh execution cannot carry providerSession");
  if (continuityMode === "continue" && !providerSession)
    throw new TypeError(
      "continue requires providerSession; sessionId alone cannot resume a provider"
    );

  const defaults: ContextEnvelope = {
    schema: CONTEXT_SCHEMA,
    items: [
      { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } },
      ...(agentSource === "provisioned"
        ? [
            {
              namespace: "octo.execution",
              name: "workspace",
              payload: { mode: "fixed", path: process.cwd() }
            }
          ]
        : []),
      { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } },
      { namespace: "octo.execution", name: "limits", payload: { run_timeout_ms: 120_000 } }
    ]
  };
  // Resolve only execution settings here. Business items and control instructions
  // retain their complete current-turn snapshot for the Host's shared renderer.
  const { resolvedExecutionPlan: plan } = resolveLocalContext(
    defaults,
    {
      schema: CONTEXT_SCHEMA,
      items: contexts.items.filter(
        (item) =>
          item.namespace === "octo.execution" ||
          (item.namespace === "octo.security" && item.name === "approval_policy")
      )
    },
    agentSource
  );
  const context = mergeContext(defaults, contexts);
  const prompt = value.inputs
    .map((part) => (part.type === "text" ? part.text : "[Image]"))
    .join("\n\n");
  if (!prompt.trim()) throw new TypeError("inputs must contain non-empty text or an image");
  const request: InvokeRequest = {
    protocolVersion: 2,
    invocationId: `invoke_${randomUUID()}`,
    runId: `run_${randomUUID()}`,
    agentSessionId: value.sessionId ?? `playboard_${randomUUID()}`,
    agentSource,
    continuityMode,
    ...(providerSession ? { providerSession } : {}),
    prompt,
    modelInput: prompt,
    modelInputParts: structuredClone(value.inputs),
    context,
    controlInstructions: contextControlInstructions(context),
    workdir: plan.workdir,
    approvalMode: plan.approval_mode,
    runtimeLimits: localRuntimeLimits(plan),
    agentConfig: {
      workdir: plan.workdir,
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.effort ? { effort: plan.effort } : {}),
      ...(plan.provider_agent_id ? { providerAgentId: plan.provider_agent_id } : {})
    }
  };
  assertInvokeRequest(request);
  return { adapterType: plan.adapter_type, protocolMode, request };
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
  const { adapterType, protocolMode, request } = preparePlayboard(value);
  if (adapterType === "openclaw") {
    const runtimeRoot = options.runtimeRoot ?? runtimePaths(defaultRuntimeHome(options.env), "default").profileRoot;
    await configureOpenClawConnection(runtimeRoot, {}, options.env);
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
    for await (const frame of host.client.invokeFrames(
      adapterType,
      { ...request, signal: controller.signal },
      { protocolMode }
    )) {
      await output(JSON.stringify(frame));
      if (
        (frame.kind === "control" &&
          frame.control.type === "interaction" &&
          frame.control.status === "pending") ||
        (frame.kind === "canonical" && frame.event.type === "interaction.requested")
      ) {
        throw new Error(
          "PLAYBOARD_INTERACTION_REQUIRED: one-shot stdin cannot answer provider interactions"
        );
      }
      if (isHostTerminal(frame) && frame.kind === "control" && frame.control.type === "state") {
        exitCode =
          frame.control.state === "completed" ? 0 : frame.control.state === "cancelled" ? 130 : 1;
      }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
