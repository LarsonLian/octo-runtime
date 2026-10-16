import {
  CONTEXT_SCHEMA,
  assertContextEnvelope,
  type ContextItem
} from "@mininglamp-oss/octo-runtime-protocol";
import type { JsonObject, JsonValue } from "./extras.js";

export type LoadContexts = (
  config: JsonObject,
  options: { readonly signal: AbortSignal }
) => readonly ContextItem[] | Promise<readonly ContextItem[]>;
export interface ChannelDependencies {
  readonly loadContexts?: LoadContexts;
}

/** Dynamic items replace the entire item at its original position. */
export function mergeConfiguredContexts(
  base: readonly ContextItem[],
  dynamic: readonly ContextItem[]
): ContextItem[] {
  assertContextEnvelope({ schema: CONTEXT_SCHEMA, items: base });
  assertContextEnvelope({ schema: CONTEXT_SCHEMA, items: dynamic });
  const items = [...base];
  const positions = new Map(items.map((item, index) => [`${item.namespace}/${item.name}`, index]));
  for (const item of dynamic) {
    const key = `${item.namespace}/${item.name}`;
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, items.length);
      items.push(item);
    } else items[position] = item;
  }
  const envelope = { schema: CONTEXT_SCHEMA, items };
  assertContextEnvelope(envelope);
  return structuredClone(items);
}

/** One bounded callback pool per Extra; timeout does not free an unsettled slot. */
export function createContextLoader(
  callback: LoadContexts | undefined,
  settings: JsonValue | undefined,
  owner: AbortSignal
) {
  const options = settings ?? {};
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => !["timeout_ms", "max_in_flight"].includes(key))
  )
    throw new Error("IM_CONTEXT_LOADING_CONFIG_INVALID");
  const timeout = options.timeout_ms ?? 5_000;
  const capacity = options.max_in_flight ?? 8;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000 ||
    typeof capacity !== "number" ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 32
  )
    throw new Error("IM_CONTEXT_LOADING_CONFIG_INVALID");
  const pending = new Set<Promise<unknown>>();
  const stop = new AbortController();
  return {
    async load(config: JsonObject, signal: AbortSignal): Promise<ContextItem[]> {
      const base = (config.context as JsonObject | undefined)?.items ?? [];
      if (!Array.isArray(base)) throw new Error("IM_CONTEXT_INVALID");
      if (!callback) return mergeConfiguredContexts(base as unknown as ContextItem[], []);
      owner.throwIfAborted();
      stop.signal.throwIfAborted();
      signal.throwIfAborted();
      if (pending.size >= capacity) throw new Error("IM_CONTEXT_LOADING_BUSY");
      const abort = new AbortController();
      const combined = AbortSignal.any([owner, stop.signal, signal, abort.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const operation = Promise.resolve()
        .then(() => {
          combined.throwIfAborted();
          return callback(structuredClone(config), { signal: combined });
        })
        .then((items) => {
          combined.throwIfAborted();
          assertBoundedJson(items);
          return mergeConfiguredContexts(base as unknown as ContextItem[], items);
        });
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => undefined);
      try {
        return await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error("IM_CONTEXT_LOADING_CANCELLED"));
            combined.addEventListener("abort", onAbort, { once: true });
            if (combined.aborted) onAbort();
            timer = setTimeout(() => {
              reject(new Error("IM_CONTEXT_LOADING_TIMEOUT"));
              abort.abort();
            }, timeout);
          })
        ]);
      } finally {
        clearTimeout(timer);
        if (onAbort) combined.removeEventListener("abort", onAbort);
      }
    },
    async close(): Promise<void> {
      stop.abort();
      await Promise.allSettled([...pending]);
    },
    get inFlight(): number {
      return pending.size;
    }
  };
}

// Check before cloning/stringifying externally supplied values. Provider code is trusted JS,
// but its result must still be finite JSON within the Context protocol's resource budget.
function assertBoundedJson(value: unknown): asserts value is readonly ContextItem[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("IM_CONTEXT_RESULT_INVALID");
  let budget = 262_144;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32 || --budget < 0) throw new Error("IM_CONTEXT_RESULT_TOO_LARGE");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "string") {
      budget -= item.length * 3;
      if (budget < 0) throw new Error("IM_CONTEXT_RESULT_TOO_LARGE");
      return;
    }
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      !item ||
      typeof item !== "object" ||
      ancestors.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
    )
      throw new Error("IM_CONTEXT_RESULT_INVALID");
    if (Array.isArray(item) && item.length > budget)
      throw new Error("IM_CONTEXT_RESULT_TOO_LARGE");
    const toJson = Object.getOwnPropertyDescriptor(item, "toJSON");
    if (toJson && (!Object.hasOwn(toJson, "value") || typeof toJson.value === "function"))
      throw new Error("IM_CONTEXT_RESULT_INVALID");
    ancestors.add(item);
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      budget -= key.length * 3;
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!Object.hasOwn(descriptor, "value")) throw new Error("IM_CONTEXT_RESULT_INVALID");
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
}
