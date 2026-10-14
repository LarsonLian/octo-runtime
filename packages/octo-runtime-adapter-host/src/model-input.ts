import { renderModelContexts, type InvokeRequest } from "@mininglamp-oss/octo-runtime-protocol";

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
