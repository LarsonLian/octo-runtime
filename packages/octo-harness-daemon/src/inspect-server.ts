import { randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { LIVE_EVENT_SOURCES, type LiveEventBus, type LiveEventSource } from "./live-event-bus.js";

const DEFAULT_HOST = "127.0.0.1";
const MIN_RANDOM_PORT = 20_001;
const MAX_ATTEMPTS = 32;
const MAX_LOG_RESPONSE_BYTES = 2 * 1024 * 1024;
const INSPECT_ASSET_ROOT = resolve(fileURLToPath(new URL("./inspect-ui/", import.meta.url)));

export interface InspectServerOptions {
  host?: string;
  port?: number;
  diagnostics?: () => Promise<unknown>;
  metrics?: () => string;
}

export interface InspectServerInfo {
  host: string;
  port: number;
  url: string;
}

export class InspectServer {
  readonly #events: LiveEventBus;
  readonly #status: () => unknown;
  readonly #logs: (runKey?: string) => Promise<unknown>;
  readonly #host: string;
  readonly #port?: number;
  readonly #diagnostics?: () => Promise<unknown>;
  readonly #metrics?: () => string;
  #server?: Server;
  #websocket?: WebSocketServer;
  #info?: InspectServerInfo;
  #starting?: Promise<InspectServerInfo>;
  #logRequestActive = false;

  constructor(
    events: LiveEventBus,
    status: () => unknown,
    logs: (runKey?: string) => Promise<unknown>,
    options: InspectServerOptions = {}
  ) {
    this.#events = events;
    this.#status = status;
    this.#logs = logs;
    this.#host = options.host ?? DEFAULT_HOST;
    this.#port = options.port;
    this.#diagnostics = options.diagnostics;
    this.#metrics = options.metrics;
    if (!this.#host.trim()) throw new Error("inspect host cannot be empty");
    if (this.#port !== undefined && (!Number.isSafeInteger(this.#port) || this.#port < 1 || this.#port > 65_535)) {
      throw new Error("inspect port must be an integer between 1 and 65535");
    }
  }

  get info(): InspectServerInfo | undefined { return this.#info; }

  async start(): Promise<InspectServerInfo> {
    if (this.#info) return this.#info;
    if (!this.#starting) {
      this.#starting = this.#listen().finally(() => { this.#starting = undefined; });
    }
    return this.#starting;
  }

  async #listen(): Promise<InspectServerInfo> {
    const capability = randomUUID();
    const host = this.#host;
    const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const server = createServer((request, response) => {
      secureHeaders(response);
      const address = server.address();
      const authority = address && typeof address !== "string"
        ? acceptedAuthority(host, address.port, request.headers.host)
        : undefined;
      if (!authority) {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${authority}`);
      if (request.method === "GET" && url.pathname === "/api/metrics") {
        if (request.headers.authorization !== `Bearer ${capability}`) {
          response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end("unauthorized\n");
          return;
        }
        if (!this.#metrics) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not available\n");
          return;
        }
        response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(this.#metrics());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/diagnostics") {
        if (request.headers.authorization !== `Bearer ${capability}`) {
          response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (!this.#diagnostics) {
          response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "not available" }));
          return;
        }
        void this.#diagnostics().then(bundle => {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(bundle));
        }).catch(error => {
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/logs") {
        if (request.headers.authorization !== `Bearer ${capability}`) {
          response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (this.#logRequestActive) {
          response.writeHead(429, { "Content-Type": "application/json; charset=utf-8", "Retry-After": "1" });
          response.end(JSON.stringify({ error: "log query already in progress" }));
          return;
        }
        this.#logRequestActive = true;
        void this.#logs(url.searchParams.get("runKey") || undefined).then(logs => {
          const encoded = boundedJsonArray(logs, MAX_LOG_RESPONSE_BYTES);
          response.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "X-Octo-Truncated": String(encoded.truncated)
          });
          response.end(encoded.body);
        }).catch(error => {
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }).finally(() => {
          this.#logRequestActive = false;
        });
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(404).end();
        return;
      }
      void serveInspectAsset(url.pathname, response);
    });
    server.on("upgrade", (request, socket, head) => {
      const address = server.address();
      if (!address || typeof address === "string") return socket.destroy();
      const authority = acceptedAuthority(host, address.port, request.headers.host);
      if (!authority) return socket.destroy();
      const expectedOrigin = `http://${authority}`;
      const url = new URL(request.url ?? "/", expectedOrigin);
      if (request.headers.origin !== expectedOrigin || url.pathname !== "/events") {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      if (url.searchParams.get("token") !== capability) {
        websocket.handleUpgrade(request, socket, head, client => client.close(4401, "invalid capability token"));
        return;
      }
      websocket.handleUpgrade(request, socket, head, client => websocket.emit("connection", client, request));
    });
    websocket.on("connection", (client, request) => {
      const address = server.address();
      if (!address || typeof address === "string") return client.close();
      const url = new URL(request.url ?? "/", `http://${urlAuthority(host, address.port)}`);
      const runKey = url.searchParams.get("runKey") || undefined;
      const sourceValue = url.searchParams.get("source") || undefined;
      const source = isSource(sourceValue) ? sourceValue : undefined;
      const replaySnapshot = url.searchParams.get("replay") !== "0";
      client.send(JSON.stringify({ kind: "status", status: this.#status(), memory: this.#events.stats }));
      const controller = new AbortController();
      client.once("close", () => controller.abort());
      void (async () => {
        try {
          for await (const event of this.#events.subscribeBytes(
            { runKey, source },
            true,
            controller.signal,
            replaySnapshot
          )) {
            if (client.readyState !== client.OPEN) break;
            await sendWebSocketFrame(client, event);
          }
        } catch (error) {
          if (client.readyState === client.OPEN) client.close(1011, error instanceof Error ? error.message.slice(0, 100) : "stream failed");
        }
      })();
    });
    const attempts = this.#port === undefined ? MAX_ATTEMPTS : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const port = this.#port ?? randomInt(MIN_RANDOM_PORT, 65_536);
      try {
        await listen(server, port, host);
        this.#server = server;
        this.#websocket = websocket;
        const info = {
          host,
          port,
          url: `http://${urlAuthority(host, port)}/?token=${encodeURIComponent(capability)}`
        };
        this.#info = info;
        return info;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    websocket.close();
    throw new Error(this.#port === undefined
      ? `inspect could not bind ${host} after ${MAX_ATTEMPTS} random port attempts`
      : `inspect could not bind ${host}:${this.#port}`);
  }

  async close(): Promise<void> {
    if (this.#starting) {
      try { await this.#starting; } catch { /* A failed start owns no resources. */ }
    }
    const server = this.#server;
    const websocket = this.#websocket;
    this.#server = undefined;
    this.#websocket = undefined;
    this.#info = undefined;
    if (!server) return;
    if (websocket) {
      for (const client of websocket.clients) client.terminate();
      websocket.close();
    }
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function urlAuthority(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function acceptedAuthority(configuredHost: string, port: number, header: string | undefined): string | undefined {
  const expected = urlAuthority(configuredHost, port);
  if (configuredHost !== "0.0.0.0" && configuredHost !== "::") return header === expected ? expected : undefined;
  if (!header || /[\s/]/.test(header)) return undefined;
  try {
    const candidate = new URL(`http://${header}`);
    return candidate.port === String(port) && candidate.host === header ? header : undefined;
  } catch {
    return undefined;
  }
}

function boundedJsonArray(value: unknown, maxBytes: number): { body: string; truncated: boolean } {
  if (!Array.isArray(value)) return { body: "[]", truncated: true };
  const items: string[] = [];
  let bytes = 2;
  for (const item of value) {
    const encoded = JSON.stringify(item);
    const itemBytes = Buffer.byteLength(encoded) + (items.length === 0 ? 0 : 1);
    if (bytes + itemBytes > maxBytes) return { body: `[${items.join(",")}]`, truncated: true };
    items.push(encoded);
    bytes += itemBytes;
  }
  return { body: `[${items.join(",")}]`, truncated: false };
}

function secureHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
  );
}

async function serveInspectAsset(pathname: string, response: ServerResponse): Promise<void> {
  let relativePath: string;
  try {
    relativePath = pathname === "/" || pathname === "/help"
      ? "index.html"
      : decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    response.writeHead(400).end();
    return;
  }
  const path = resolve(INSPECT_ASSET_ROOT, relativePath);
  if (path !== INSPECT_ASSET_ROOT && !path.startsWith(`${INSPECT_ASSET_ROOT}${sep}`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(path);
    if (relativePath !== "index.html") {
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    }
    response.writeHead(200, { "Content-Type": contentType(path) });
    response.end(body);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(500).end();
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".json": return "application/json; charset=utf-8";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function isSource(value: string | undefined): value is LiveEventSource {
  return value !== undefined && (LIVE_EVENT_SOURCES as readonly string[]).includes(value);
}

async function sendWebSocketFrame(client: WebSocket, encoded: Buffer): Promise<void> {
  for (let offset = 0; offset < encoded.byteLength; offset += 16 * 1024) {
    const chunk = encoded.subarray(offset, Math.min(offset + 16 * 1024, encoded.byteLength));
    const fin = offset + chunk.byteLength >= encoded.byteLength;
    await new Promise<void>((resolve, reject) => {
      client.send(chunk, { binary: false, fin }, error => error ? reject(error) : resolve());
    });
  }
}
