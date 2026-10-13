import { assertContextEnvelope, contextItem } from "./context.js";
import type { ContextEnvelope, ContextItem } from "./generated/protocol-types.js";

export function isModelContextItem(item: ContextItem): boolean {
  return (
    (item.namespace.startsWith("extra.") && item.namespace.length > 6) ||
    (item.namespace === "octo.content" && ["inline", "references"].includes(item.name))
  );
}

/** A display format for model input, not an XML document or a business resolver. */
export function renderModelContexts(context: ContextEnvelope): string {
  assertContextEnvelope(context);
  const items = context.items.filter(isModelContextItem);
  if (!items.length) return "";
  return [
    "<--- 上下文信息开始：以下内容为当前上下文信息 --->",
    "<contexts>",
    ...items.map((item) =>
      [
        `  <context-item namespace="${item.namespace}" name="${item.name}">`,
        ...(item.guidance ? [`    指引: ${item.guidance}`] : []),
        `    数据: ${JSON.stringify(sorted(item.payload))}`,
        "  </context-item>"
      ].join("\n")
    ),
    "</contexts>",
    "<--- 上下文信息结束 --->"
  ].join("\n");
}

/** Sources are validated by the producer's authorization boundary, not by rendering. */
export function contextControlInstructions(context: ContextEnvelope): string {
  assertContextEnvelope(context);
  const entries = contextItem(context, "octo.control", "instructions")?.payload.entries;
  return Array.isArray(entries)
    ? entries.map((entry) => (entry as { text: string }).text).join("\n\n")
    : "";
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, sorted(child)])
    );
  return value;
}
