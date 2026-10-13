import type { ContextPreparationReceipt } from "@mininglamp-oss/octo-harness-context-builder/context-preparation";

/**
 * 使用当前 run/lease/fence 向 Worker 提交准备回执；仅 HTTP 成功确认后返回。
 * 拒绝、取消或响应未知均抛错，调用方不能据本地资源存在就启动 Provider。
 */
export async function recordContextPreparation(receipt: ContextPreparationReceipt, options: {
  baseUrl: string; headers: Record<string, string>; runId: string; leaseId: string; fencingToken: number; signal: AbortSignal;
}): Promise<void> {
  const response = await fetch(options.baseUrl.replace(/\/$/, "") + "/v1/runtime/context/prepare", {
    method: "POST", headers: { ...options.headers, "Content-Type": "application/json" }, redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    body: JSON.stringify({ run_id: options.runId, lease_id: options.leaseId, fencing_token: options.fencingToken, preparation: receipt })
  });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: { code?: string } } | undefined;
    throw new Error(body?.error?.code ?? "CONTEXT_PREPARATION_REJECTED");
  }
  await response.body?.cancel();
}
