/** 只携带连接协议事实；恢复策略由 Bot 编排决定，不保留响应正文或凭据。 */
export class ImConnectionError extends Error {
  constructor(
    code: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0
  ) {
    super(code);
  }
}

export function connectionFailure(error: unknown): ImConnectionError {
  if (error instanceof ImConnectionError) return error;
  const code =
    error instanceof Error && /^IM_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "IM_CONNECTION_FAILED";
  return new ImConnectionError(code, false);
}

export async function connectionFetch(
  url: string,
  init: RequestInit,
  phase: "AUTH" | "REGISTER"
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new ImConnectionError(`IM_${phase}_TIMEOUT`, true);
    if (init.signal?.aborted) throw error;
    // fetch 的 TypeError 可能包含敏感 URL；只暴露阶段和确定的网络分类。
    throw new ImConnectionError(`IM_${phase}_NETWORK_ERROR`, true);
  }
}

export async function httpConnectionFailure(
  response: Response,
  phase: "AUTH" | "REGISTER"
): Promise<ImConnectionError> {
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : undefined;
  const date = retryAfter ? Date.parse(retryAfter) : NaN;
  const retryAfterMs = Math.max(0, seconds !== undefined ? seconds * 1000 : date - Date.now());
  await response.body?.cancel();
  // 未确认业务错误 schema 前不猜测占用码；非暂态 HTTP 保留真实状态并终止恢复。
  return new ImConnectionError(
    `IM_${phase}_HTTP_${response.status}`,
    response.status === 429 || response.status >= 500,
    Number.isFinite(retryAfterMs) ? retryAfterMs : 0
  );
}

export async function connectionJson(
  response: Response,
  phase: "AUTH" | "REGISTER",
  invalidCode: string
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))
      throw new ImConnectionError(`IM_${phase}_TIMEOUT`, true);
    if (error instanceof TypeError) throw new ImConnectionError(`IM_${phase}_NETWORK_ERROR`, true);
    throw new ImConnectionError(invalidCode, false);
  }
}
