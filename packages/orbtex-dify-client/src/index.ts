export type JsonRecord = Record<string, unknown>;
export type FetchLike = typeof globalThis.fetch;

export interface DifyClientOptions {
  baseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  userPrefix?: string;
  fetch?: FetchLike;
}

export interface DifySseFrame {
  event?: string;
  id?: string;
  data?: string;
  retry?: number;
}

export interface ParseSseOptions {
  maxFrameChars?: number;
}

export interface DifyProbeResult {
  available: boolean;
  command: string;
  reason?: string;
  status?: number;
}

export class DifyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
    this.name = "DifyHttpError";
  }
}

export class DifyProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DifyProtocolError";
  }
}

export class DifyClient {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly userPrefix: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;

  constructor(options: DifyClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.dify.ai/v1");
    this.apiKeyEnv = options.apiKeyEnv ?? "DIFY_API_KEY";
    this.userPrefix = options.userPrefix ?? "orbtex";
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") throw new TypeError("Dify adapter requires global fetch or options.fetch");
  }

  resolveApiKey(): string {
    const value = this.#apiKey ?? process.env[this.apiKeyEnv];
    if (!value) throw new Error(`Dify API key is not configured; set ${this.apiKeyEnv}`);
    return value;
  }

  userFor(sessionId: string, providerSession?: JsonRecord, configuredUser?: string): string {
    const resumed = optionalString(providerSession?.user);
    return resumed ?? configuredUser ?? `${this.userPrefix}:${sessionId}`;
  }

  async probe(path = "/parameters"): Promise<DifyProbeResult> {
    const command = this.url(path);
    try {
      const response = await this.#fetch(command, {
        method: "GET",
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000)
      });
      if (!response.ok) {
        const failure = await responseFailure(response);
        return { available: false, command, status: response.status, reason: failure.message };
      }
      await response.body?.cancel();
      return { available: true, command, status: response.status };
    } catch (error) {
      return { available: false, command, reason: errorMessage(error) };
    }
  }

  async openSse(path: string, body: JsonRecord, signal?: AbortSignal): Promise<Response> {
    const response = await this.#fetch(this.url(path), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json", Accept: "text/event-stream" }),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
    if (!response.ok) throw await responseFailure(response);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("text/event-stream")) {
      const preview = (await response.text()).slice(0, 512);
      throw new DifyProtocolError(`Dify returned ${contentType || "unknown content-type"} instead of text/event-stream${preview ? `: ${preview}` : ""}`);
    }
    if (!response.body) throw new DifyProtocolError("Dify SSE response has no body");
    return response;
  }

  async stop(path: string, user: string): Promise<void> {
    const response = await this.#fetch(this.url(path), {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ user }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw await responseFailure(response);
    await response.body?.cancel();
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private headers(additional: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.resolveApiKey()}`,
      ...additional
    };
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  { maxFrameChars = 1_048_576 }: ParseSseOptions = {}
): AsyncGenerator<DifySseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > maxFrameChars && !findFrameBoundary(buffer)) {
        throw new DifyProtocolError(`Dify SSE frame exceeds ${maxFrameChars} characters`);
      }

      while (true) {
        const boundary = findFrameBoundary(buffer);
        if (!boundary) break;
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        if (block.length > maxFrameChars) {
          throw new DifyProtocolError(`Dify SSE frame exceeds ${maxFrameChars} characters`);
        }
        const frame = parseSseBlock(block);
        if (frame) yield frame;
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      if (buffer.length > maxFrameChars) throw new DifyProtocolError(`Dify SSE frame exceeds ${maxFrameChars} characters`);
      const frame = parseSseBlock(buffer);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseDifyEvent(frame: DifySseFrame): JsonRecord | null {
  if (!frame.data || frame.data === "[DONE]") return null;
  let value: unknown;
  try {
    value = JSON.parse(frame.data);
  } catch (error) {
    throw new DifyProtocolError(`invalid Dify SSE JSON: ${errorMessage(error)}`);
  }
  const event = asRecord(value, "Dify SSE data");
  if (frame.event && event.event === undefined) event.event = frame.event;
  return event;
}

export function asRecord(value: unknown, name = "value"): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

export function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new TypeError("Dify baseUrl must use HTTPS unless it targets localhost");
  }
  return normalized;
}

function findFrameBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r\n\r\n|\n\n|\r\r/.exec(value);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function parseSseBlock(block: string): DifySseFrame | null {
  const frame: DifySseFrame = {};
  const data: string[] = [];
  let hasField = false;

  for (const line of block.split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      hasField = true;
    } else if (field === "event") {
      frame.event = value;
      hasField = true;
    } else if (field === "id") {
      if (!value.includes("\0")) frame.id = value;
      hasField = true;
    } else if (field === "retry") {
      if (/^\d+$/.test(value)) frame.retry = Number(value);
      hasField = true;
    }
  }

  if (data.length > 0) frame.data = data.join("\n");
  return hasField ? frame : null;
}

async function responseFailure(response: Response): Promise<DifyHttpError> {
  const preview = (await response.text()).slice(0, 4096);
  let code: string | undefined;
  let message = preview || `Dify HTTP ${response.status}`;
  try {
    const body = optionalRecord(JSON.parse(preview));
    code = optionalString(body?.code);
    message = optionalString(body?.message) ?? message;
  } catch {
    // Keep the bounded text preview when the error body is not JSON.
  }
  return new DifyHttpError(message, response.status, code);
}
