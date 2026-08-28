import { assertCanonicalEvent, assertInvokeRequest, isTerminal } from "@orbtex-ai/protocol";

export class AdapterHost {
  #adapters = new Map();
  #active = new Map();

  register(adapter) {
    if (this.#adapters.has(adapter.metadata.type)) throw new Error(`duplicate adapter: ${adapter.metadata.type}`);
    this.#adapters.set(adapter.metadata.type, adapter);
  }

  list() {
    return [...this.#adapters.values()].map(a => a.metadata);
  }

  async *invoke(adapterType, request) {
    assertInvokeRequest(request);
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    const controller = new AbortController();
    this.#active.set(request.invocationId, controller);
    let terminal;
    const messages = new Map();
    const prepareMessage = event => {
      if (!event.type.startsWith("message.")) return { prefix: [], event };
      const channel = event.payload.channel ?? "final";
      const messageId = event.payload.messageId ?? `${request.runId}:${channel}`;
      const state = messages.get(channel);
      const prepared = { ...event, payload: { ...event.payload, channel, messageId } };
      const prefix = !state && event.type !== "message.create"
        ? [{ type: "message.create", payload: { role: "assistant", status: "streaming", channel, messageId } }]
        : [];
      messages.set(channel, { messageId, open: event.type !== "message.update" });
      return { prefix, event: prepared };
    };
    const closeMessages = status => [...messages.entries()]
      .filter(([, state]) => state.open)
      .map(([channel, state]) => ({ type: "message.update", payload: { role: "assistant", status, channel, messageId: state.messageId } }));
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
      for (const event of closeMessages(terminal.type === "run.finished" ? "completed" : terminal.type === "run.error" ? "failed" : "stopped")) yield event;
      yield terminal;
    } catch (error) {
      for (const event of closeMessages(controller.signal.aborted ? "stopped" : "failed")) yield event;
      if (controller.signal.aborted) yield { type: "run.stopped", payload: { reason: String(controller.signal.reason ?? "cancelled") } };
      else if (terminal?.type === "run.error") yield { ...terminal, payload: { ...terminal.payload, cleanupError: error.message } };
      else yield { type: "run.error", payload: { message: error.message, adapterType } };
    } finally {
      this.#active.delete(request.invocationId);
    }
  }

  async probe(adapterType) {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    if (!adapter.probe) return { available: true, adapterType, unchecked: true };
    return adapter.probe();
  }

  cancel(invocationId, reason = "cancelled") {
    const controller = this.#active.get(invocationId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }
}

export { AdapterHostRpcClient, AdapterHostRpcServer } from "./rpc.js";
export { spawnAdapterHost } from "./process.js";
