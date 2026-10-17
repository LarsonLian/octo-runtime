import {
  CONTEXT_SCHEMA,
  assertContextEnvelope,
  type ContextItem
} from "@mininglamp-oss/octo-runtime-protocol";
import type { JsonObject, JsonValue } from "./extras.js";

/**
 * 宿主业务函数：每轮接收独立 Bot 配置快照，返回 ContextItem 列表而非 envelope。
 * 函数引用在初始化时固定，但每次调用可读取宿主最新的 Agent 提示词，无需重载 Extra。
 * 存储、授权及读取一致性归宿主；同步读取和异步 IO 均支持，IO 须传递 signal。
 */
export type LoadContexts = (
  config: JsonObject,
  options: { readonly signal: AbortSignal }
) => readonly ContextItem[] | Promise<readonly ContextItem[]>;
export interface ChannelDependencies {
  readonly loadContexts?: LoadContexts;
}

/**
 * 只合并本轮数据，不保留历史。动态同 key 整项替换且保留静态位置，新项按返回顺序追加。
 * instructions.entries 也不拼接：覆盖方须显式保留需要的固定人设；空动态列表不删除静态项。
 * 两个来源先分别校验，避免同源重复 key 被覆盖掩盖；返回副本隔离宿主与插件的后续修改。
 */
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

/**
 * 每个 Extra 共用一个有界回调池，而非每个 Bot 各建一份额度。
 * 超时只结束本轮等待，不能强制结束外部 Promise；实际操作结束前仍须占额，防止挂起 IO 累积。
 */
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
      // 满额直接拒绝，不再建立等待队列；否则排队的配置副本和闭包也可能无限增长。
      if (pending.size >= capacity) throw new Error("IM_CONTEXT_LOADING_BUSY");
      const abort = new AbortController();
      const combined = AbortSignal.any([owner, stop.signal, signal, abort.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      const operation = Promise.resolve()
        .then(() => {
          combined.throwIfAborted();
          // 每轮重新调用同一业务函数，不在启动时预取；下一轮可读到宿主已更新的数据。
          return callback(structuredClone(config), { signal: combined });
        })
        .then((items) => {
          // 超时或取消后的迟到结果不能再校验、复制或进入本轮模型输入。
          combined.throwIfAborted();
          assertBoundedJson(items);
          return mergeConfiguredContexts(base as unknown as ContextItem[], items);
        });
      pending.add(operation);
      // 跟踪真实操作，而非 race 的等待结果；迟到 reject 也必须被消费，避免未处理拒绝。
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
      // 这里等待实际 IO 退出；外层 Extra loader 负责 5 秒宽限，超时后保留失败实例阻止重载。
      stop.abort();
      await Promise.allSettled([...pending]);
    },
    get inFlight(): number {
      return pending.size;
    }
  };
}

// 先限制外部结果的深度和遍历成本，再进入协议校验、序列化和复制，避免校验本身放大内存。
// 这不是 JS 沙箱：无法限制业务函数执行期间自行分配的内存或阻塞事件循环。
function assertBoundedJson(value: unknown): asserts value is readonly ContextItem[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("IM_CONTEXT_RESULT_INVALID");
  // 预检预算覆盖节点、键和字符；最终字节数及 item 约束仍由 Context v3 校验器决定。
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
    // 不执行业务 getter/toJSON；否则一次普通校验也可能触发副作用或生成更大的对象。
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
