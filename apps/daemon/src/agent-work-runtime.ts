import { randomUUID } from "node:crypto";
import { hostname, platform, arch } from "node:os";
import WebSocket from "ws";
import type { AdapterHostRpcClient } from "@mininglamp-oss/octo-harness-adapter-host";
import type { AgentConfig, CanonicalEvent, InvokeRequest, ProviderSession } from "@mininglamp-oss/octo-harness-protocol";

const PROTOCOL_VERSION = 1;

export interface AgentWorkRuntimeOptions {
  baseUrl: string;
  token: string;
  tenantId: string;
  subjectId: string;
  runtimeId?: string;
  runtimeName: string;
  fingerprint: string;
  reconnectMs?: number;
}

interface ExecutionEnvelope {
  schema_version: number;
  run_id: string;
  harness_session_id: string;
  provider_session?: ProviderSession;
  execution_request: {
    id: string;
    agent_id: string;
    agent_revision_id: string;
    source_type: string;
    source_id: string;
    policy?: Record<string, unknown>;
    delivery_context?: Record<string, unknown>;
  };
  agent_revision: {
    definition?: Record<string, unknown>;
    execution_profile?: Record<string, unknown>;
  };
  immutable_execution_input: {
    content?: Record<string, unknown>;
  };
}

interface RuntimeCommand {
  server_seq: number;
  command_id: string;
  run_id: string;
  type: "run.start" | "run.cancel" | "run.steer";
  payload: unknown;
  lease_id: string;
  fencing_token: number;
}

interface WireEnvelope {
  version: number;
  id: string;
  type: string;
  runtime_id?: string;
  seq?: number;
  ack?: number;
  sent_at: string;
  payload: unknown;
}

interface ActiveRun {
  invocationId: string;
  leaseId: string;
  fencingToken: number;
}

export class AgentWorkRuntime {
  readonly #options: AgentWorkRuntimeOptions;
  readonly #host: AdapterHostRpcClient;
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #eventAcks = new Map<string, { resolve(stored: boolean): void; reject(error: Error): void }>();
  #runtimeId = "";
  #socket?: WebSocket;
  #heartbeat?: NodeJS.Timeout;
  #loop?: Promise<void>;
  #stopped = true;
  #lastAckedCommandSeq = 0;
  #connected = false;

  constructor(options: AgentWorkRuntimeOptions, host: AdapterHostRpcClient) {
    this.#options = options;
    this.#host = host;
  }

  get status(): Record<string, unknown> {
    return {
      enabled: true,
      connected: this.#connected,
      runtimeId: this.#runtimeId || this.#options.runtimeId,
      activeRuns: this.#activeRuns.size,
      lastAckedCommandSeq: this.#lastAckedCommandSeq
    };
  }

  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#runtimeId = this.#options.runtimeId ?? await this.#register();
    await this.#connect();
    this.#loop = this.#readLoop();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    for (const run of this.#activeRuns.values()) {
      await this.#host.cancel(run.invocationId, "runtime shutdown").catch(() => undefined);
    }
    this.#socket?.close(1000, "runtime shutdown");
    await this.#loop?.catch(() => undefined);
    this.#rejectPendingAcks(new Error("Agent Work runtime closed"));
  }

  async #register(): Promise<string> {
    const response = await fetch(`${stripSlash(this.#options.baseUrl)}/api/v1/runtimes/register`, {
      method: "POST",
      headers: this.#headers(true),
      body: JSON.stringify({
        kind: "local",
        name: this.#options.runtimeName,
        device: {
          fingerprint: this.#options.fingerprint,
          os: platform(),
          arch: arch(),
          hostname: hostname()
        },
        runtime_version: "0.1.0",
        protocol_version: PROTOCOL_VERSION,
        capabilities: { adapters: (await this.#host.list()).map(item => item.type) }
      })
    });
    const body = await response.json() as { runtime?: { id?: string }; error?: { message?: string } };
    if (!response.ok || !body.runtime?.id) {
      throw new Error(`Agent Work runtime registration failed (${response.status}): ${body.error?.message ?? "invalid response"}`);
    }
    return body.runtime.id;
  }

  async #connect(): Promise<void> {
    const url = new URL(`${stripSlash(this.#options.baseUrl)}/api/v1/runtimes/connect`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: this.#headers(false) });
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (error: Error): void => {
        socket.off("open", onOpen);
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
    this.#socket = socket;
    this.#send("runtime.hello", {
      last_acked_command_seq: this.#lastAckedCommandSeq,
      active_run_ids: [...this.#activeRuns.keys()],
      runtime_version: "0.1.0"
    });
  }

  async #readLoop(): Promise<void> {
    while (!this.#stopped) {
      const socket = this.#socket;
      if (socket) {
        try {
          await this.#waitForDisconnect(socket);
        } catch (error) {
          console.error(`octo-harness Agent Work runtime connection failed: ${errorMessage(error)}`);
        }
        if (this.#socket === socket) this.#socket = undefined;
      }
      this.#connected = false;
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
      this.#rejectPendingAcks(new Error("Agent Work runtime disconnected"));
      if (this.#stopped) return;
      while (!this.#stopped && !this.#socket) {
        await delay(this.#options.reconnectMs ?? 1_000);
        try {
          await this.#connect();
        } catch (error) {
          console.error(`octo-harness Agent Work runtime reconnect failed: ${errorMessage(error)}`);
        }
      }
    }
  }

  #waitForDisconnect(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        socket.off("message", onMessage);
        socket.off("close", onClose);
        socket.off("error", onError);
      };
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onMessage = (data: WebSocket.RawData): void => {
        void (async () => {
          const envelope = JSON.parse(rawDataText(data)) as WireEnvelope;
          await this.#receive(envelope);
        })().catch((error: unknown) => {
          socket.terminate();
          settle(error instanceof Error ? error : new Error(String(error)));
        });
      };
      const onClose = (): void => settle();
      const onError = (error: Error): void => settle(error);
      socket.on("message", onMessage);
      socket.once("close", onClose);
      socket.once("error", onError);
    });
  }

  async #receive(envelope: WireEnvelope): Promise<void> {
    if (envelope.version !== PROTOCOL_VERSION) throw new Error(`unsupported Agent Work protocol ${envelope.version}`);
    if (envelope.type === "runtime.welcome") {
      const payload = asRecord(envelope.payload);
      const everyMs = typeof payload.heartbeat_every_ms === "number" ? payload.heartbeat_every_ms : 30_000;
      this.#connected = true;
      if (this.#heartbeat) clearInterval(this.#heartbeat);
      this.#heartbeat = setInterval(() => this.#send("runtime.heartbeat", { runtime_version: "0.1.0" }), everyMs);
      return;
    }
    if (envelope.type === "runtime.command") {
      await this.#acceptCommand(envelope.payload as RuntimeCommand);
      return;
    }
    if (envelope.type === "event.ack") {
      const payload = asRecord(envelope.payload);
      const key = `${String(payload.run_id)}:${String(payload.seq)}`;
      const pending = this.#eventAcks.get(key);
      if (pending) {
        this.#eventAcks.delete(key);
        pending.resolve(payload.stored === true);
      }
      return;
    }
    if (envelope.type === "error") {
      const payload = asRecord(envelope.payload);
      throw new Error(`Agent Work protocol error ${String(payload.code)}: ${String(payload.message)}`);
    }
  }

  async #acceptCommand(command: RuntimeCommand): Promise<void> {
    if (!command?.command_id || !command.run_id || !command.type) throw new Error("invalid runtime.command payload");
    if (command.type === "run.cancel") {
      const active = this.#activeRuns.get(command.run_id);
      const cancelled = active ? (await this.#host.cancel(active.invocationId, "control plane cancel")).cancelled : false;
      this.#ackCommand(command, true, cancelled ? undefined : { code: "RUN_NOT_ACTIVE" });
      return;
    }
    if (command.type !== "run.start") {
      this.#ackCommand(command, false, { code: "UNSUPPORTED_COMMAND", message: command.type });
      return;
    }
    if (this.#activeRuns.has(command.run_id)) {
      this.#ackCommand(command, true);
      return;
    }
    let request: InvokeRequest;
    let adapterType: string;
    try {
      const mapped = mapExecutionEnvelope(command.payload as ExecutionEnvelope);
      request = mapped.request;
      adapterType = mapped.adapterType;
    } catch (error) {
      this.#ackCommand(command, false, { code: "INVALID_EXECUTION_ENVELOPE", message: errorMessage(error) });
      return;
    }
    this.#activeRuns.set(command.run_id, {
      invocationId: request.invocationId,
      leaseId: command.lease_id,
      fencingToken: command.fencing_token
    });
    this.#ackCommand(command, true);
    void this.#execute(command, adapterType, request);
  }

  async #execute(command: RuntimeCommand, adapterType: string, request: InvokeRequest): Promise<void> {
    let seq = 1;
    let finalText = "";
    try {
      await this.#sendRunEvent(command, seq++, "run.started", {});
      for await (const event of this.#host.invoke(adapterType, request)) {
        if (event.type === "run.running" || event.type === "run.queued") continue;
        finalText = accumulateFinalText(finalText, event);
        const mapped = mapRuntimeEvent(event, finalText);
        await this.#sendRunEvent(command, seq++, mapped.type, mapped.payload);
      }
    } catch (error) {
      await this.#sendRunEvent(command, seq, "run.failed", {
        code: "ADAPTER_INVOCATION_FAILED",
        message: errorMessage(error),
        text: finalText
      }).catch(sendError => console.error(`failed to report run failure: ${errorMessage(sendError)}`));
    } finally {
      this.#activeRuns.delete(command.run_id);
    }
  }

  async #sendRunEvent(command: RuntimeCommand, seq: number, type: string, payload: Record<string, unknown>): Promise<boolean> {
    const key = `${command.run_id}:${seq}`;
    const ack = new Promise<boolean>((resolve, reject) => this.#eventAcks.set(key, { resolve, reject }));
    this.#send("run.event", {
      event_id: `event_${randomUUID()}`,
      run_id: command.run_id,
      seq,
      type,
      payload,
      lease_id: command.lease_id,
      fencing_token: command.fencing_token,
      occurred_at: new Date().toISOString()
    }, seq);
    return ack;
  }

  #ackCommand(command: RuntimeCommand, accepted: boolean, error?: Record<string, unknown>): void {
    this.#lastAckedCommandSeq = Math.max(this.#lastAckedCommandSeq, command.server_seq);
    this.#send("command.ack", {
      command_id: command.command_id,
      server_seq: command.server_seq,
      accepted,
      ...(error ? { error } : {})
    }, undefined, command.server_seq);
  }

  #send(type: string, payload: unknown, seq?: number, ack?: number): void {
    if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) throw new Error("Agent Work runtime socket is not open");
    this.#socket.send(JSON.stringify({
      version: PROTOCOL_VERSION,
      id: `msg_${randomUUID()}`,
      type,
      runtime_id: this.#runtimeId,
      ...(seq === undefined ? {} : { seq }),
      ...(ack === undefined ? {} : { ack }),
      sent_at: new Date().toISOString(),
      payload
    } satisfies WireEnvelope));
  }

  #headers(json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#options.token}`,
      "X-Tenant-ID": this.#options.tenantId,
      "X-Subject-ID": this.#options.subjectId,
      ...(json ? { "Content-Type": "application/json" } : {})
    };
  }

  #rejectPendingAcks(error: Error): void {
    for (const pending of this.#eventAcks.values()) pending.reject(error);
    this.#eventAcks.clear();
  }
}

export function accumulateFinalText(current: string, event: CanonicalEvent): string {
  if (!event.type.startsWith("message.") || (event.payload.channel ?? "final") !== "final") return current;
  const text = stringValue(event.payload.text);
  if (!text) return current;
  if (event.type === "message.delta") return current + text;
  return text;
}

export function mapExecutionEnvelope(envelope: ExecutionEnvelope): { adapterType: string; request: InvokeRequest } {
  if (!envelope?.run_id || !envelope.harness_session_id || !envelope.agent_revision || !envelope.immutable_execution_input) {
    throw new TypeError("execution envelope is missing run/session/revision/immutable execution input");
  }
  const profile = asRecord(envelope.agent_revision.execution_profile);
  const definition = asRecord(envelope.agent_revision.definition);
  const adapterType = stringValue(profile.adapter_type) ?? normalizeAdapterType(stringValue(profile.default_adapter) ?? "codex");
  const agentConfig = asRecord(profile.agent_config) as AgentConfig;
  const workdir = stringValue(profile.workdir) ?? stringValue(agentConfig.workdir);
  if (!workdir) throw new TypeError("execution_profile.workdir is required for a local runtime");
  const context = {
    schemaVersion: envelope.schema_version,
    agentId: envelope.execution_request.agent_id,
    agentRevisionId: envelope.execution_request.agent_revision_id,
    sourceType: envelope.execution_request.source_type,
    sourceId: envelope.execution_request.source_id,
    immutableExecutionInput: envelope.immutable_execution_input.content ?? {}
  };
  return {
    adapterType,
    request: {
      invocationId: `invoke_${randomUUID()}`,
      sessionId: envelope.harness_session_id,
      runId: envelope.run_id,
      prompt: renderImmutableExecutionInputPrompt(envelope.immutable_execution_input.content),
      workdir,
      appendInstructions: stringValue(definition.instructions) ?? "",
      context,
      ...(envelope.provider_session ? { providerSession: envelope.provider_session } : {}),
      agentConfig: { ...agentConfig, workdir }
    }
  };
}

export function renderImmutableExecutionInputPrompt(content: Record<string, unknown> | undefined): string {
  const input = asRecord(content);
  const parts = Array.isArray(input.parts) ? input.parts : [];
  const current = parts.map(part => {
    const value = asRecord(part);
    return value.type === "text" && typeof value.text === "string" ? value.text : "";
  }).filter(Boolean).join("\n");
  const blocks: string[] = [];
  const contextRefs = Array.isArray(input.context_refs) ? input.context_refs : [];
  const recent = contextRefs.flatMap((ref): unknown[] => {
    const value = asRecord(ref);
    return value.kind === "recent_group" && Array.isArray(value.messages)
      ? value.messages as unknown[]
      : [];
  });
  if (recent.length > 0) {
    blocks.push("[Recent group messages]\n" + recent.map(message => {
      const value = asRecord(message);
      const author = stringValue(value.author_name) ?? stringValue(value.author_id) ?? "unknown";
      return `${author}: ${stringValue(value.text) ?? ""}`;
    }).join("\n"));
  }
  const reply = asRecord(input.reply_to);
  if (stringValue(reply.text)) {
    blocks.push(`[Quoted message from ${stringValue(reply.author_name) ?? stringValue(reply.author_id) ?? "unknown"}]\n${stringValue(reply.text)}`);
  }
  blocks.push(`[Current message]\n${current}`);
  return blocks.join("\n\n");
}

function rawDataText(data: WebSocket.RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export function mapRuntimeEvent(event: CanonicalEvent, finalText: string): { type: string; payload: Record<string, unknown> } {
	const terminalText = finalText || stringValue(event.payload.text) || "";
  switch (event.type) {
    case "run.finished":
      return { type: "run.completed", payload: { ...event.payload, text: terminalText } };
    case "run.error":
      return { type: "run.failed", payload: { code: "PROVIDER_ERROR", ...event.payload, text: terminalText } };
    case "run.stopped":
      return { type: "run.cancelled", payload: { ...event.payload, text: terminalText } };
    default:
      return { type: event.type, payload: event.payload };
  }
}

function normalizeAdapterType(value: string): string {
  return value.endsWith("-local") ? value.slice(0, -"-local".length) : value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
