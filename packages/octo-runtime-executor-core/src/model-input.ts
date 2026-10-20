import type { ContextEnvelope, InvokeRequest } from "@mininglamp-oss/octo-runtime-protocol";

const MODEL_CONTEXT_PATTERNS = [/^extra\.[^/]+\/[^/]+$/, /^octo\.content\/(inline|references)$/];

/** Fixed model text rendering; business capture and execution configuration are separate. */
export function renderModelContexts(context: ContextEnvelope): string {
  const items = context.items.filter((item) =>
    MODEL_CONTEXT_PATTERNS.some((pattern) => pattern.test(item.namespace + "/" + item.name))
  );
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

/** Called once, after Host freezes the original request and before adapter dispatch. */
export function withModelContexts(request: InvokeRequest): InvokeRequest {
  const rendered = renderModelContexts(request.context);
  if (!rendered) return request;
  return {
    ...request,
    modelInput: [rendered, request.modelInput].filter(Boolean).join("\n\n"),
    ...(request.modelInputParts
      ? { modelInputParts: [{ type: "text" as const, text: rendered }, ...request.modelInputParts] }
      : {}),
    ...(request.freshFallbackModelInput
      ? { freshFallbackModelInput: [rendered, request.freshFallbackModelInput].join("\n\n") }
      : {}),
    ...(request.freshFallbackModelInputParts
      ? {
          freshFallbackModelInputParts: [
            { type: "text" as const, text: rendered },
            ...request.freshFallbackModelInputParts
          ]
        }
      : {})
  };
}
