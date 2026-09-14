import {
  assertCanonicalEvent,
  assertInvokeRequest,
  isTerminal,
  type CanonicalEvent,
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

/** Provider-neutral metadata the Host uses for registration and capability discovery. */
export interface HostedAdapterMetadata {
  type: string;
  capabilities: string[];
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
  readonly #observe: NonNullable<AdapterHostOptions["observe"]>;
  readonly #canonicalSink?: AdapterHostOptions["canonicalSink"];

  constructor(options: AdapterHostOptions = {}) {
    // A disabled receipt keeps observability additive: existing embeddings and
    // third-party hosts do not need to configure a logger to invoke adapters.
    this.#observe = options.observe ?? (() => Promise.resolve({
      captureId: "disabled",
      state: "disabled",
      complete: false
    }));
    this.#canonicalSink = options.canonicalSink;
  }

  /** Register an adapter by `metadata.type`; the same type cannot be overwritten twice. */
  register(adapter: HostedAdapter): void {
    if (this.#adapters.has(adapter.metadata.type)) throw new Error(`duplicate adapter: ${adapter.metadata.type}`);
    this.#adapters.set(adapter.metadata.type, adapter);
  }

  /** List registered adapters, for Agent registration and control-plane display. */
  list(): HostedAdapterMetadata[] {
    return [...this.#adapters.values()].map(adapter => adapter.metadata);
  }

  /** Invoke an adapter and emit lifecycle-corrected canonical events upstream. */
  async *invoke(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
    assertInvokeRequest(request);
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    const controller = new AbortController();
    this.#active.set(request.invocationId, controller);
    let terminal: CanonicalEvent | undefined;
    const messages = new Map<string, MessageState>();
    // Correlation fields come from the validated host request, never from the
    // adapter. This prevents a plugin from accidentally attributing sensitive
    // input to another Run while still letting it describe transport details.
    const context: AdapterInvocationContext = {
      observe: observation => this.#observe({
        ...(typeof request.context?.profile === "string" ? { profile: request.context.profile } : {}),
        runId: request.runId,
        invocationId: request.invocationId,
        agentSessionId: request.agentSessionId,
        adapterType
      }, observation)
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
        ? [{
            type: "message.create",
            payload: { role: "assistant", status: "streaming", channel, messageId, ...(stepId ? { stepId } : {}), ...analysisMetadata }
          }]
        : [];
      messages.set(messageId, { messageId, channel, open: event.type !== "message.update", ...(stepId ? { stepId } : {}), ...analysisMetadata });
      return { prefix, event: prepared };
    };

    const closeMessages = (status: string, stepId?: string): CanonicalEvent[] => {
      const closed: CanonicalEvent[] = [];
      for (const state of messages.values()) {
        if (!state.open || (stepId !== undefined && (state.channel !== "analysis" || state.stepId !== stepId))) continue;
        state.open = false;
        closed.push({
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
      for await (const event of adapter.invoke({ ...request, signal: controller.signal }, context)) {
        assertCanonicalEvent(event);
        this.#canonicalSink?.({
          ...(typeof request.context?.profile === "string" ? { profile: request.context.profile } : {}),
          runId: request.runId,
          invocationId: request.invocationId,
          agentSessionId: request.agentSessionId,
          adapterType
        }, event);
        if (terminal) throw new Error(`${adapterType} emitted after terminal event`);
        if (isTerminal(event)) terminal = event;
        else {
          if (event.type === "model_step.finished") {
            for (const closed of closeMessages(event.payload.status, event.payload.stepId)) yield closed;
          }
          const prepared = prepareMessage(event);
          for (const prefix of prepared.prefix) yield prefix;
          yield prepared.event;
        }
      }
      terminal ??= { type: "run.stopped", payload: { reason: "adapter_stream_ended" } };
      const messageStatus = terminal.type === "run.finished" ? "completed" : terminal.type === "run.error" ? "failed" : "stopped";
      for (const event of closeMessages(messageStatus)) yield event;
      yield terminal;
    } catch (error) {
      for (const event of closeMessages(controller.signal.aborted ? "stopped" : "failed")) yield event;
      if (controller.signal.aborted) {
        yield { type: "run.stopped", payload: { reason: String(controller.signal.reason ?? "cancelled") } };
      } else if (terminal?.type === "run.error") {
        yield { ...terminal, payload: { ...terminal.payload, cleanupError: errorMessage(error) } };
      } else {
        const code = errorCode(error);
        yield {
          type: "run.error",
          payload: {
            message: errorMessage(error),
            adapterType,
            ...(code ? { code } : {})
          }
        };
      }
    } finally {
      this.#active.delete(request.invocationId);
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
    if (!controller) return false;
    controller.abort(reason);
    return true;
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

export {
  AdapterHostRpcClient,
  AdapterHostRpcServer,
  type AdapterHostRpc,
  type RpcTrace,
  type RpcTraceDirection
} from "./rpc.js";
export { spawnAdapterHost } from "./process.js";
export type { AdapterHostProcess, SpawnAdapterHostOptions } from "./process.js";
