import {
  assertContextEnvelope,
  type ContextEnvelope
} from "@mininglamp-oss/octo-runtime-protocol/browser";

export interface ContextCaptureScope {
  identity: string;
  generation: number;
}
export interface ContextProvider {
  id: string;
  version: string;
  capture(
    scope: Readonly<ContextCaptureScope>,
    signal: AbortSignal
  ): Promise<ContextEnvelope> | ContextEnvelope;
}
export interface CapturedProviderContext {
  scope: ContextCaptureScope;
  providers: Array<{ id: string; version: string }>;
  context: ContextEnvelope;
}

/** Host-owned providers compose current facts without adding protocol scenario IDs. */
export class ContextProviderRegistry {
  private readonly providers = new Map<string, ContextProvider>();

  register(provider: ContextProvider): () => void {
    if (
      !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(provider.id) ||
      !provider.version ||
      provider.version.length > 96 ||
      typeof provider.capture !== "function"
    )
      throw new TypeError("CONTEXT_PROVIDER_INVALID");
    if (this.providers.has(provider.id)) throw new TypeError("CONTEXT_PROVIDER_DUPLICATED");
    const registered = { ...provider };
    this.providers.set(provider.id, registered);
    return () => {
      if (this.providers.get(provider.id) === registered) this.providers.delete(provider.id);
    };
  }

  async capture(
    scope: ContextCaptureScope,
    signal: AbortSignal,
    current: () => ContextCaptureScope = () => scope
  ): Promise<CapturedProviderContext> {
    if (!scope.identity || !Number.isSafeInteger(scope.generation) || scope.generation < 0)
      throw new TypeError("CONTEXT_CAPTURE_SCOPE_INVALID");
    const frozenScope = Object.freeze({ ...scope });
    const providers = [...this.providers.values()];
    const context: ContextEnvelope = { schema: "octo.context-envelope/v3", items: [] };
    const check = (): void => {
      signal.throwIfAborted();
      const next = current();
      if (next.identity !== frozenScope.identity || next.generation !== frozenScope.generation)
        throw new TypeError("CONTEXT_CAPTURE_SCOPE_CHANGED");
    };
    check();
    for (const provider of providers) {
      let abort: () => void = () => undefined;
      let value: ContextEnvelope;
      try {
        value = await Promise.race([
          Promise.resolve().then(() => {
            check();
            return provider.capture(frozenScope, signal);
          }),
          new Promise<never>((_resolve, reject) => {
            abort = () =>
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new Error("CONTEXT_CAPTURE_CANCELLED", { cause: signal.reason })
              );
            signal.addEventListener("abort", abort, { once: true });
          })
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      const contribution = structuredClone(value);
      check();
      assertContextEnvelope(contribution);
      for (const item of contribution.items) {
        const existing = context.items.find(
          (value) => value.namespace === item.namespace && value.name === item.name
        );
        if (existing && item.namespace === "octo.content" && item.name === "inline") {
          existing.payload.entries = [
            ...(existing.payload.entries as unknown[]),
            ...(item.payload.entries as unknown[])
          ];
        } else if (existing) {
          throw new TypeError(`CONTEXT_PROVIDER_ITEM_DUPLICATED: ${item.namespace}/${item.name}`);
        } else context.items.push(item);
      }
      assertContextEnvelope(context);
    }
    check();
    return {
      scope: { ...frozenScope },
      providers: providers.map(({ id, version }) => ({ id, version })),
      context: structuredClone(context)
    };
  }
}
