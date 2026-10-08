import { InvocationExperience } from "./experience.js";
import {
  assertCanonicalEvent,
  assertInteractionResponse,
  assertInvokeRequest,
  hasImageInput,
  capabilities,
  failurePayload,
  isTerminal,
  type CanonicalEvent,
  type InteractionResponse,
  type InvokeRequest,
  type MessageChannel,
  type MessageExposure,
  type MessageProvenance
} from "@mininglamp-oss/octo-harness-protocol";
import type {
  AdapterInvocationContext,
  CaptureReceipt,
  ObservationIdentity,
  ProviderObservation
} from "@mininglamp-oss/octo-harness-observability";
import { InvocationWatchdog, AdapterWatchdogTimeoutError, WATCHDOG_CAPABILITY, ACTIVITY_CAPABILITY, type WatchdogDiagnostic } from "./watchdog.js";

/** Provider-neutral metadata the Host uses for registration and capability discovery. */
export interface HostedAdapterMetadata {
  type: string;
  capabilities: string[];
  processModel?: string;
  transport?: string;
  providerVersion?: string | null;
  providerPath?: string | null;
  available?: boolean;
  unavailableReason?: string | null;
}

/**
 * The minimal contract any Octo Harness adapter must implement.
 * invoke may wrap a CLI subprocess, ACP, WebSocket or an in-process
 * implementation, as long as it emits a canonical event stream.
 */
export interface HostedAdapter {
  metadata: HostedAdapterMetadata;
  probe?: () => unknown;
  /**
   * The optional context preserves compatibility with third-party adapters that
   * implement the original one-argument method. When present, it is the only
   * supported path for recording provider input and dispatch milestones.
   */
  invoke(request: InvokeRequest, context?: AdapterInvocationContext): AsyncIterable<CanonicalEvent>;
  /** Resume a provider request that paused this exact active invocation. */
  respondInteraction?(invocationId: string, response: InteractionResponse): Promise<void>;
}

/** Host-owned dependencies used to attach trusted identity to plugin observations. */
export interface AdapterHostOptions {
  /**
   * Persist an adapter observation under the invocation identity supplied by
   * the host. A durable-capture implementation may reject this Promise to stop
   * dispatch before sensitive provider input leaves the process.
   */
  observe?: (identity: ObservationIdentity, observation: ProviderObservation) => Promise<CaptureReceipt>;
  /** Receives adapter output after schema validation and before host correction. */
  canonicalSink?: (identity: ObservationIdentity, event: CanonicalEvent) => void;
  diagnosticSink?: (identity: ObservationIdentity, diagnostic: WatchdogDiagnostic) => void;
}

interface MessageState {
  messageId: string;
  channel: MessageChannel;
  open: boolean;
  stepId?: string;
  exposure?: MessageExposure;
  provenance?: MessageProvenance;
}

/**
 * The in-process registry and lifecycle gatekeeper for adapters.
 * It validates plugin input/output, fills in the message lifecycle, guarantees
 * a single terminal, and turns cancellation into an AbortSignal.
 */
export class AdapterHost {
  readonly #adapters = new Map<string, HostedAdapter>();
  readonly #active = new Map<string, AbortController>();
  readonly #activeAdapters = new Map<string, HostedAdapter>();
  readonly #acceptedTerminals = new Set<string>();
  readonly #observe: NonNullable<AdapterHostOptions["observe"]>;
  readonly #canonicalSink?: AdapterHostOptions["canonicalSink"];
  readonly #diagnosticSink?: AdapterHostOptions["diagnosticSink"];

  constructor(options: AdapterHostOptions = {}) {
    // A disabled receipt keeps observability additive: existing embeddings and
    // third-party hosts do not need to configure a logger to invoke adapters.
    this.#observe = options.observe ?? (() => Promise.resolve({
      captureId: "disabled",
      state: "disabled",
      complete: false
    }));
    this.#canonicalSink = options.canonicalSink;
    this.#diagnosticSink = options.diagnosticSink;
  }

  /** Register an adapter by `metadata.type`; the same type cannot be overwritten twice. */
  register(adapter: HostedAdapter): void {
    if (this.#adapters.has(adapter.metadata.type)) throw new Error(`duplicate adapter: ${adapter.metadata.type}`);
    this.#adapters.set(adapter.metadata.type, adapter);
  }

  /** List registered adapters, for Agent registration and control-plane display. */
  list(): HostedAdapterMetadata[] {
    return [...this.#adapters.values()].map(adapter => ({ ...adapter.metadata, capabilities: [...new Set([...adapter.metadata.capabilities, WATCHDOG_CAPABILITY])] }));
  }

  /** Report installed provider identity separately from adapter registration. */
  async describe(): Promise<HostedAdapterMetadata[]> {
    return Promise.all([...this.#adapters.values()].map(async adapter => {
      let probe: Record<string, unknown> = {};
      let unavailableReason: string | null = adapter.probe ? "probe_invalid" : "probe_missing";
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result: unknown = await Promise.race([
          Promise.resolve().then(() => adapter.probe?.()),
          new Promise<undefined>(resolve => { timer = setTimeout(() => {
            unavailableReason = "probe_timeout";
            resolve(undefined);
          }, 3_000); })
        ]);
        if (result && typeof result === "object") probe = result as Record<string, unknown>;
        if (probe.available === false) unavailableReason = typeof probe.reason === "string" ? probe.reason : "provider_unavailable";
      } catch {
        unavailableReason = "probe_failed";
        // A failed probe must not make the whole adapter host unavailable.
      } finally {
        if (timer) clearTimeout(timer);
      }
      const available = probe.available === true && typeof probe.command === "string" && probe.command.length > 0;
      return {
        ...adapter.metadata,
        capabilities: [...new Set([...adapter.metadata.capabilities, WATCHDOG_CAPABILITY])],
        available,
        unavailableReason: available ? null : unavailableReason,
        providerPath: available ? probe.command as string : null,
        providerVersion: typeof probe.version === "string" ? probe.version : null
      };
    }));
  }

  /** Invoke an adapter and emit lifecycle-corrected canonical events upstream. */
  async *invoke(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
    assertInvokeRequest(request);
    const registered = this.#adapters.get(adapterType);
    if (hasImageInput(request) && !registered?.metadata.capabilities.includes(capabilities.INPUT_IMAGE)) {
      throw new Error(`UNSUPPORTED_INPUT_MODALITY: ${adapterType} does not implement native image input`);
    }
    if (request.approvalMode !== "full_access" && (!registered?.metadata.capabilities.includes(capabilities.INTERACTION_RESPONSE) || typeof registered.respondInteraction !== "function")) {
      throw new Error(`APPROVAL_MODE_UNSUPPORTED: ${adapterType} does not implement execution-time approval responses`);
    }
    const experience = new InvocationExperience();
    const provider = this.#invokeProvider(adapterType, request);
    let pending = provider.next();
    void pending.catch(() => undefined);
    let finalBody = false;
    try {
      for (const event of experience.start()) yield event;
      while (true) {
        const next = await pending;
        if (next.done) break;
        const event = next.value;
        if (event.type.startsWith("message.") && event.payload.channel === "final" && event.payload.text) finalBody = true;
        if (event.type === "run.completed" && !finalBody && typeof event.payload.text === "string" && event.payload.text) {
          const finalMessage: CanonicalEvent = { protocolVersion: 2, type: "message.update", payload: { messageId: `${request.runId}:final`, channel: "final", status: "completed", text: event.payload.text } };
          for (const projected of experience.accept(finalMessage)) yield projected;
        }
        for (const projected of experience.accept(event)) yield projected;
        pending = provider.next();
        void pending.catch(() => undefined);
      }
    } finally {
      await provider.return(undefined);
    }
  }

  async *#invokeProvider(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    if (request.mcpServers && Object.keys(request.mcpServers).length > 0
      && !adapter.metadata.capabilities.includes(capabilities.MCP_DYNAMIC)) {
      throw new Error(`adapter ${adapterType} does not support dynamic MCP configuration`);
    }
    const controller = new AbortController();
    this.#active.set(request.invocationId, controller);
    this.#activeAdapters.set(request.invocationId, adapter);
    let terminal: CanonicalEvent | undefined;
    let outcome = "stopped";
    const identity: ObservationIdentity = {
      ...(typeof request.runMetadata?.profile === "string" ? { profile: request.runMetadata.profile } : {}),
      ...(typeof request.runMetadata?.runtimeId === "string" ? { runtimeId: request.runMetadata.runtimeId } : {}),
      runId: request.runId, invocationId: request.invocationId, agentSessionId: request.agentSessionId, adapterType
    };
    const watchdog = new InvocationWatchdog(request.runtimeLimits, controller,
      adapter.metadata.capabilities.includes(ACTIVITY_CAPABILITY),
      diagnostic => this.#diagnosticSink?.(identity, {
        ...diagnostic,
        data: { ...diagnostic.data, agentRevisionId: request.runMetadata?.agentRevisionId }
      }));
    let iterator: AsyncIterator<CanonicalEvent> | undefined;
    let cleanup: Promise<unknown> | undefined;
    let cleanupWait: Promise<void> | undefined;
    const closeIterator = (): Promise<unknown> => cleanup ??= Promise.resolve().then(() => iterator?.return?.()).catch(() => undefined);
    const waitCleanup = (): Promise<void> => cleanupWait ??= boundedCleanup(closeIterator(), watchdog.limits.cancelGraceMs);
    // The timer can fire while a consumer is paused at yield.
    const onAbort = () => { void closeIterator(); };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const messages = new Map<string, MessageState>();
    // Correlation fields come from the validated host request, never from the
    // adapter. This prevents a plugin from accidentally attributing sensitive
    // input to another Run while still letting it describe transport details.
    const context: AdapterInvocationContext = {
      observe: observation => this.#observe(identity, observation),
      reportActivity: activity => watchdog.activity(activity)
    };

    // A provider may emit only deltas; here the host fills in the message lifecycle and stabilizes the messageId.
    const prepareMessage = (event: CanonicalEvent): { prefix: CanonicalEvent[]; event: CanonicalEvent } => {
      const isMessage = event.type === "message.create"
        || event.type === "message.delta"
        || event.type === "message.update";
      if (!isMessage) return { prefix: [], event };
      const channel = event.payload.channel ?? "final";
      const messageId = event.payload.messageId ?? `${request.runId}:${channel}`;
      const state = messages.get(messageId);
      const stepId = typeof event.payload.stepId === "string" ? event.payload.stepId : state?.stepId;
      const analysisMetadata = channel === "analysis" ? {
        exposure: event.payload.exposure ?? "unknown",
        provenance: event.payload.provenance ?? { provider: adapterType, nativeEvent: "unknown" }
      } : {};
      const prepared: CanonicalEvent = {
        ...event,
        payload: { ...event.payload, channel, messageId, ...analysisMetadata }
      };
      const prefix: CanonicalEvent[] = !state && event.type !== "message.create"
        ? [{ protocolVersion: 2,
            type: "message.create",
            payload: { role: "assistant", status: "streaming", channel, messageId, ...(stepId ? { stepId } : {}), ...analysisMetadata }
          }]
        : [];
      const closed = event.type === "message.update" && ["completed", "failed", "cancelled", "canceled", "stopped"].includes(String(event.payload.status));
      messages.set(messageId, { messageId, channel, open: !closed, ...(stepId ? { stepId } : {}), ...analysisMetadata });
      return { prefix, event: prepared };
    };

    const closeMessages = (status: string, stepId?: string): CanonicalEvent[] => {
      const closed: CanonicalEvent[] = [];
      for (const state of messages.values()) {
        if (!state.open || (stepId !== undefined && (state.channel !== "analysis" || state.stepId !== stepId))) continue;
        state.open = false;
        closed.push({ protocolVersion: 2,
          type: "message.update",
          payload: {
            role: "assistant", status, channel: state.channel, messageId: state.messageId,
            ...(state.stepId ? { stepId: state.stepId } : {}),
            ...(state.exposure ? { exposure: state.exposure } : {}),
            ...(state.provenance ? { provenance: state.provenance } : {})
          }
        });
      }
      return closed;
    };

    try {
      iterator = adapter.invoke({ ...request, signal: controller.signal }, context)[Symbol.asyncIterator]();
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const pendingNext = iterator.next();
        const next = terminal
          ? await withCleanupDeadline(pendingNext, watchdog.limits.cancelGraceMs, controller)
          : await waitForNext(pendingNext, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (next.done) break;
        const adapterEvent = next.value;
        assertCanonicalEvent(adapterEvent);
        const event: CanonicalEvent = adapterEvent.type === "run.failed"
          ? { protocolVersion: 2,
              type: "run.failed",
              payload: failurePayload(adapterEvent.payload, {
                stage: "provider.invoke",
                defaultDomain: "provider",
                runId: request.runId,
                source: { component: "octo-harness", adapter: adapterType }
              })
            }
          : adapterEvent;
        watchdog.canonical(event);
        this.#canonicalSink?.({
          ...(typeof request.runMetadata?.profile === "string" ? { profile: request.runMetadata.profile } : {}),
          ...(typeof request.runMetadata?.runtimeId === "string" ? { runtimeId: request.runMetadata.runtimeId } : {}),
          runId: request.runId,
          invocationId: request.invocationId,
          agentSessionId: request.agentSessionId,
          adapterType
        }, event);
        if (terminal) throw new Error(`${adapterType} emitted after terminal event`);
        if (isTerminal(event)) {
          terminal = event;
          // A later user cancellation cannot replace an accepted provider terminal.
          this.#acceptedTerminals.add(request.invocationId);
        }
        else {
          if (event.type === "model_step.finished") {
            for (const closed of closeMessages(event.payload.status, event.payload.stepId)) yield closed;
          }
          const prepared = prepareMessage(event);
          for (const prefix of prepared.prefix) yield prefix;
          yield prepared.event;
        }
      }
      terminal ??= { protocolVersion: 2, type: "run.cancelled", payload: { reason: "adapter_stream_ended" } };
      const messageStatus = terminal.type === "run.completed" ? "completed" : terminal.type === "run.failed" ? "failed" : "cancelled";
      outcome = messageStatus;
      for (const event of closeMessages(messageStatus)) yield event;
      yield terminal;
    } catch (caught) {
      const error = controller.signal.reason instanceof AdapterWatchdogTimeoutError ? controller.signal.reason : caught;
      const userCancelled = controller.signal.aborted && !(controller.signal.reason instanceof AdapterWatchdogTimeoutError);
      outcome = userCancelled ? "stopped" : "failed";
      if (error instanceof AdapterWatchdogTimeoutError && error.timeoutReason === "cleanup_timeout") {
        try { this.#diagnosticSink?.(identity, { event: "timeout", data: { ...watchdog.snapshot(), timeoutReason: error.timeoutReason, timeoutMs: error.timeoutMs } }); } catch { /* best effort */ }
      }
      watchdog.dispose();
      if (!controller.signal.aborted) controller.abort(error);
      await waitCleanup();
      for (const event of closeMessages(userCancelled ? "cancelled" : "failed")) yield event;
      if (userCancelled) {
        yield { protocolVersion: 2, type: "run.cancelled", payload: { reason: String(controller.signal.reason ?? "cancelled") } };
      } else if (terminal?.type === "run.failed") {
        yield terminal;
      } else {
        const code = errorCode(error);
        yield { protocolVersion: 2,
          type: "run.failed",
          payload: failurePayload({
            message: errorMessage(error),
            adapterType,
            ...(code ? { code } : {}),
            ...watchdogFailureDetails(error)
          }, {
            stage: "adapter.invoke",
            defaultDomain: "adapter",
            runId: request.runId,
            source: { component: "octo-harness", adapter: adapterType }
          })
        };
      }
    } finally {
      watchdog.finish(outcome);
      if (!terminal && !controller.signal.aborted) controller.abort("consumer closed");
      await waitCleanup();
      controller.signal.removeEventListener("abort", onAbort);
      this.#active.delete(request.invocationId);
      this.#activeAdapters.delete(request.invocationId);
      this.#acceptedTerminals.delete(request.invocationId);
    }
  }

  /** Run the adapter's own environment probe; return an unchecked-available status when there is no probe. */
  probe(adapterType: string): unknown {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    if (!adapter.probe) return { available: true, adapterType, unchecked: true };
    return adapter.probe();
  }

  /** Abort an active invocation; returns false when that invocation no longer exists or has already ended. */
  cancel(invocationId: string, reason = "cancelled"): boolean {
    const controller = this.#active.get(invocationId);
    if (!controller || this.#acceptedTerminals.has(invocationId)) return false;
    controller.abort(reason);
    return true;
  }

  /** Route an answer only to the adapter instance that owns the active invocation. */
  async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
    assertInteractionResponse(response);
    const adapter = this.#activeAdapters.get(invocationId);
    if (!adapter || this.#acceptedTerminals.has(invocationId)) {
      throw new Error(`invocation is not active: ${invocationId}`);
    }
    if (!adapter.respondInteraction) {
      throw new Error(`adapter does not support interaction responses: ${adapter.metadata.type}`);
    }
    if (!adapter.metadata.capabilities.includes(capabilities.INTERACTION_RESPONSE)) {
      throw new Error(`adapter did not declare interaction response capability: ${adapter.metadata.type}`);
    }
    await adapter.respondInteraction(invocationId, response);
  }

  /** Abort every invocation and wait briefly for adapter cleanup to reap its
   * provider processes. Used when the RPC parent disappears or shuts down. */
  async shutdown(reason = "adapter host shutdown", timeoutMs = 2_500): Promise<void> {
    for (const controller of this.#active.values()) controller.abort(reason);
    if (this.#active.size === 0) return;
    const deadline = Date.now() + timeoutMs;
    await new Promise<void>(resolve => {
      const check = (): void => {
        if (this.#active.size === 0 || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function waitForNext<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "cancelled")));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

async function boundedCleanup(cleanup: Promise<unknown>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([cleanup, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function withCleanupDeadline<T>(pending: Promise<T>, graceMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new AdapterWatchdogTimeoutError("cleanup", graceMs, "cleanup_timeout");
        reject(error);
        controller.abort(error);
      }, graceMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function watchdogFailureDetails(error: unknown): Record<string, unknown> {
  return error instanceof AdapterWatchdogTimeoutError
    ? { timeoutStage: error.timeoutStage, timeoutMs: error.timeoutMs, timeoutReason: error.timeoutReason, watchdog: error.evidence }
    : {};
}

export {
  AdapterHostRpcClient,
  AdapterHostRpcServer,
  type AdapterHostRpc,
  type RpcTrace,
  type RpcTraceDirection
} from "./rpc.js";
export { spawnAdapterHost } from "./process.js";
export type { AdapterHostProcess, SpawnAdapterHostOptions } from "./process.js";
