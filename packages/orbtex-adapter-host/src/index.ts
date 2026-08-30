import {
  assertCanonicalEvent,
  assertInvokeRequest,
  isTerminal,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageChannel
} from "@orbtex-ai/orbtex-protocol";

/** Host 用于注册和能力发现的 provider-neutral metadata。 */
export interface HostedAdapterMetadata {
  type: string;
  capabilities: string[];
}

/**
 * 任意 Orbtex adapter 必须实现的最小契约。
 * invoke 可以封装 CLI 子进程、ACP、WebSocket 或进程内实现，只要输出 canonical event stream。
 */
export interface HostedAdapter {
  metadata: HostedAdapterMetadata;
  probe?: () => unknown;
  invoke(request: InvokeRequest): AsyncIterable<CanonicalEvent>;
}

interface MessageState {
  messageId: string;
  open: boolean;
}

/**
 * Adapter 的进程内 registry 与生命周期守门员。
 * 它校验插件输入输出、补齐 message lifecycle、保证单终态并把取消转换为 AbortSignal。
 */
export class AdapterHost {
  readonly #adapters = new Map<string, HostedAdapter>();
  readonly #active = new Map<string, AbortController>();

  /** 按 `metadata.type` 注册 adapter；同一类型不能重复覆盖。 */
  register(adapter: HostedAdapter): void {
    if (this.#adapters.has(adapter.metadata.type)) throw new Error(`duplicate adapter: ${adapter.metadata.type}`);
    this.#adapters.set(adapter.metadata.type, adapter);
  }

  /** 列出已注册 adapter，供 Agent 注册和控制面展示。 */
  list(): HostedAdapterMetadata[] {
    return [...this.#adapters.values()].map(adapter => adapter.metadata);
  }

  /** 调用 adapter，并向上游输出经过生命周期修正的 canonical events。 */
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

  /** 运行 adapter 自带的环境探测；没有 probe 时返回 unchecked 可用状态。 */
  probe(adapterType: string): unknown {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    if (!adapter.probe) return { available: true, adapterType, unchecked: true };
    return adapter.probe();
  }

  /** 中止活动 invocation；返回 false 表示该 invocation 已不存在或已经结束。 */
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
