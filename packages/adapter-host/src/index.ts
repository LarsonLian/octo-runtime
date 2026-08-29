import {
  assertCanonicalEvent,
  assertInvokeRequest,
  isTerminal,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageChannel
} from "@orbtex-ai/protocol";

export interface HostedAdapterMetadata extends Record<string, unknown> {
  type: string;
  capabilities: string[];
}

export interface HostedAdapter {
  metadata: HostedAdapterMetadata;
  probe?: () => unknown;
  invoke(request: InvokeRequest): AsyncIterable<CanonicalEvent>;
}

interface MessageState {
  messageId: string;
  open: boolean;
}

export class AdapterHost {
  readonly #adapters = new Map<string, HostedAdapter>();
  readonly #active = new Map<string, AbortController>();

  register(adapter: HostedAdapter): void {
    if (this.#adapters.has(adapter.metadata.type)) throw new Error(`duplicate adapter: ${adapter.metadata.type}`);
    this.#adapters.set(adapter.metadata.type, adapter);
  }

  list(): HostedAdapterMetadata[] {
    return [...this.#adapters.values()].map(adapter => adapter.metadata);
  }

  async *invoke(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
    assertInvokeRequest(request);
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    const controller = new AbortController();
    this.#active.set(request.invocationId, controller);
    let terminal: CanonicalEvent | undefined;
    const messages = new Map<MessageChannel, MessageState>();

    // provider 可以只发送 delta；host 在这里补齐 message 生命周期并稳定 messageId。
    const prepareMessage = (event: CanonicalEvent): { prefix: CanonicalEvent[]; event: CanonicalEvent } => {
      if (!event.type.startsWith("message.")) return { prefix: [], event };
      const channel = event.payload.channel ?? "final";
      const messageId = event.payload.messageId ?? `${request.runId}:${channel}`;
      const state = messages.get(channel);
      const prepared: CanonicalEvent = { ...event, payload: { ...event.payload, channel, messageId } };
      const prefix: CanonicalEvent[] = !state && event.type !== "message.create"
        ? [{ type: "message.create", payload: { role: "assistant", status: "streaming", channel, messageId } }]
        : [];
      messages.set(channel, { messageId, open: event.type !== "message.update" });
      return { prefix, event: prepared };
    };

    const closeMessages = (status: string): CanonicalEvent[] => [...messages.entries()]
      .filter(([, state]) => state.open)
      .map(([channel, state]) => ({
        type: "message.update",
        payload: { role: "assistant", status, channel, messageId: state.messageId }
      }));

    try {
      for await (const event of adapter.invoke({ ...request, signal: controller.signal })) {
        assertCanonicalEvent(event);
        if (terminal) throw new Error(`${adapterType} emitted after terminal event`);
        if (isTerminal(event)) terminal = event;
        else {
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
        yield { type: "run.error", payload: { message: errorMessage(error), adapterType } };
      }
    } finally {
      this.#active.delete(request.invocationId);
    }
  }

  probe(adapterType: string): unknown {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    if (!adapter.probe) return { available: true, adapterType, unchecked: true };
    return adapter.probe();
  }

  cancel(invocationId: string, reason = "cancelled"): boolean {
    const controller = this.#active.get(invocationId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { AdapterHostRpcClient, AdapterHostRpcServer } from "./rpc.js";
export { spawnAdapterHost } from "./process.js";
export type { AdapterHostProcess, SpawnAdapterHostOptions } from "./process.js";
