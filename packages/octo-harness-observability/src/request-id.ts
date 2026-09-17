import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-Id";
const MAX_REQUEST_ID_LENGTH = 128;

/** Mint a log-safe id suitable for HTTP and WebSocket handshake correlation. */
export function createRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

/** Accept only visible ASCII so remote response headers cannot inject logs. */
export function normalizeRequestId(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > MAX_REQUEST_ID_LENGTH) return undefined;
  for (const character of normalized) {
    const code = character.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return undefined;
  }
  return normalized;
}

export function responseRequestId(response: Response, fallback: string): string {
  return normalizeRequestId(response.headers.get(REQUEST_ID_HEADER)) ?? fallback;
}
