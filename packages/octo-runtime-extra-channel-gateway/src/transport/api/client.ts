/**
 * HTTP 基础设施：统一鉴权请求、超时、限流重试和 64 位消息 ID 解析。
 * 防止 ID 精度丢失与无限等待；不读取 CLI 配置，也不记录 token。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import { randomUUID } from "node:crypto";
import { OctoApiError, OctoApiStatusMismatchError, OctoApiProtocolError } from "./errors.js";

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 生成出站消息的客户端幂等编号 client_msg_no（UUID）。
 *
 * WuKongIM 以 client_msg_no 做服务端去重（见 pkg/wkdb/message.go：相同
 * client_msg_no 只落库一条）。图文混排 payload 体积大、链路长、更易触发重试，
 * 故出站统一附带 client_msg_no，保证重试不会产生重复消息。
 */
export function generateClientMsgNo(): string {
  return randomUUID();
}

const DEFAULT_HEADERS = {
  "Content-Type": "application/json"
};

/**
 * Parse JSON with int64 message_id protection.
 * Converts 16+ digit numeric message_id values to strings before JSON.parse
 * to prevent JavaScript precision loss for IDs exceeding Number.MAX_SAFE_INTEGER.
 */
export function parseOctoJson<T>(text: string): T {
  const safeText = text.replace(/"message_id"\s*:\s*(\d{16,})/g, '"message_id":"$1"');
  return JSON.parse(safeText) as T;
}

/** At most three attempts per call: the original plus two retries. */
export const MAX_429_RETRIES = 2;

/**
 * A wait longer than this is not worth holding the call for. Used only to decide whether
 * to retry — never to shorten the server's requested wait, because a shortened wait means
 * going back before the server said we could.
 */
export const MAX_RETRY_AFTER_MS = 10_000;

/** Cumulative backoff sleep budget for one call. Not an end-to-end deadline. */
export const MAX_429_BACKOFF_WAIT_MS = 15_000;

/**
 * Deadline applied to a POST when the caller expresses none of its own.
 *
 * `fetch` has no default timeout, so without this a hung connection blocks its caller
 * indefinitely. Callers that pass a signal keep full control: the events long poll asks
 * for far more than this on purpose, and intersecting the two would abort a legitimate
 * hold and discard the batch the server was about to return.
 */
export const DEFAULT_POST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

/**
 * Absolute ceiling on one POST attempt, applied even when the caller supplied its own signal.
 *
 * The caller's signal is honoured as-is for anything under this, because it knows what this
 * particular request needs — the events long poll deliberately asks for up to 40s and cutting
 * it short would abort a legitimate hold. But a signal that carries no deadline at all would
 * otherwise make the request unbounded, which is the class of hang this module is trying to
 * remove; nothing here has any business running for a full minute.
 */
export const POST_HARD_CEILING_MS = 60_000;

/** Sleep that rejects as soon as the caller's signal aborts, preserving `cause`. */
function backoffSleep(ms: number, signal: AbortSignal | undefined, cause: unknown): Promise<void> {
  const aborted = (): Error => new Error("aborted while backing off from a rate limit", { cause });
  // Checked before arming anything: an abort that landed between the response returning
  // and this call would otherwise be missed entirely and we would serve the full wait.
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      // Surface the rate limiting as the cause; without it the failure site shows only a
      // generic abort and the 429 diagnosis is lost.
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface JsonRequestOptions {
  retryOn429?: boolean;
  /** Receipt uploads use the caller's throttled diagnostic instead. */
  logRateLimit?: boolean;
  idempotencyKey?: string;
  expectedStatus?: number;
  redirect?: "error" | "follow" | "manual";
  /** Optional decoded response cap for callers that fetch large documents. */
  maxResponseBytes?: number;
}

async function readResponseText(response: Response, maxBytes?: number): Promise<string> {
  if (maxBytes === undefined) return response.text();
  const reader = response.body?.getReader();
  if (!reader) return "";
  let bytes = 0;
  const chunks: Buffer[] = [];
  try {
    // Content-Length can understate a compressed or chunked response, so the
    // decoded stream remains authoritative even after this early rejection.
    if (Number(response.headers.get("content-length")) > maxBytes) {
      throw new Error("Octo API response exceeds byte limit");
    }
    for (;;) {
      const { done, value } = (await reader.read()) as { done: boolean; value?: Uint8Array };
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Octo API response stream is invalid");
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Octo API response exceeds byte limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function requestJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  method: "GET" | "POST",
  payload: Record<string, unknown> | undefined,
  signal?: AbortSignal,
  opts: JsonRequestOptions = {}
): Promise<T | undefined> {
  const url = `${apiUrl.replace(/\/+$/, "")}${path}`;
  const retryOn429 = opts.retryOn429 ?? true;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw signal.reason;

    // Rebuilt per attempt: a deadline created once outside the loop is shared across
    // attempts, so a retry could start on a budget the first attempt already spent.
    const fetchSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(POST_HARD_CEILING_MS)])
      : AbortSignal.timeout(DEFAULT_POST_TIMEOUT_MS);

    const response = await fetch(url, {
      method,
      headers: {
        ...(payload ? DEFAULT_HEADERS : {}),
        Authorization: `Bearer ${botToken}`,
        ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {})
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: fetchSignal,
      ...(opts.redirect ? { redirect: opts.redirect } : {})
    });

    if (response.ok) {
      if (opts.expectedStatus !== undefined && response.status !== opts.expectedStatus) {
        throw new OctoApiStatusMismatchError(path, response.status, opts.expectedStatus);
      }
      const text = await readResponseText(response, opts.maxResponseBytes);
      if (!text) return undefined;
      try {
        return parseOctoJson<T>(text);
      } catch {
        throw new OctoApiProtocolError(
          `Octo API ${path} returned invalid JSON: ${text.slice(0, 200)}`
        );
      }
    }

    const body = await readResponseText(response, opts.maxResponseBytes).catch(() => "");
    const err = OctoApiError.from(response, path, body);

    if (!err.isRateLimited) throw err;

    // Logged on every rate limit, including the one we give up on: the scope and the
    // remaining count are the only way to tell which bucket ran dry and whose traffic
    // filled it, and they are discarded once this error leaves here.
    if (opts.logRateLimit !== false)
      console.warn(
        `octo: rate limited on ${path} (scope=${err.rateLimitScope ?? "?"} ` +
          `remaining=${err.rateLimitRemaining ?? "?"} retry_after=${err.retryAfterMs}ms) ` +
          `attempt=${attempt + 1}/${retryOn429 ? MAX_429_RETRIES + 1 : 1}`
      );

    if (!retryOn429 || attempt >= MAX_429_RETRIES) throw err;
    // A wait this long is the server telling us to go away, not to try again shortly.
    // Clamping it down instead would just return before it was ready for us.
    if (err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;

    // Jitter only ever adds. Retry-After is the earliest acceptable retry time, so a
    // downward jitter would put us back on the server before it allowed it.
    const delay = Math.round(err.retryAfterMs * (1 + Math.random() * 0.25));
    if (waited + delay > MAX_429_BACKOFF_WAIT_MS) throw err;

    await backoffSleep(delay, signal, err);
    waited += delay;
  }
}

export async function postJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  opts?: JsonRequestOptions
): Promise<T | undefined> {
  return requestJson(apiUrl, botToken, path, "POST", payload, signal, opts);
}

export async function getJson<T>(
  apiUrl: string,
  botToken: string,
  path: string,
  signal?: AbortSignal,
  opts?: JsonRequestOptions
): Promise<T | undefined> {
  return requestJson(apiUrl, botToken, path, "GET", undefined, signal, opts);
}
