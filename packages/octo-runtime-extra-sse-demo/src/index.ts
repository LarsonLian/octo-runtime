import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { InvokeInput } from "@mininglamp-oss/octo-runtime-protocol";
import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";

export const name = "sse-demo";
import { INVOKE_REQUEST_MAX_BYTES } from "@mininglamp-oss/octo-runtime-protocol";

/** Initializes once; HTTP routing, authentication and delivery belong to this extra. */
export default async function load(ctx: ExtraContext, config: JsonObject): Promise<void> {
  const { host = "127.0.0.1", port = 3002, token } = config;
  let server: Server | undefined;
  const errors: string[] = [];
  const requests = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  ctx.onStatus(() => ({
    listening: server?.listening ?? false,
    ...(typeof host === "string" && isIP(host) ? { host } : {}),
    ...(typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
      ? { port }
      : {}),
    activeRequests: requests.size,
    errors
  }));
  if (typeof host !== "string" || !isIP(host)) errors.push("SSE_HOST_INVALID");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    errors.push("SSE_PORT_INVALID");
  if (typeof token !== "string" || !token || /\s/.test(token)) errors.push("SSE_TOKEN_REQUIRED");
  if (errors.length) return;
  const expected = Buffer.from(`Bearer ${token as string}`);
  const listener = (server = createServer((req, res) => {
    const task = handle(req, res);
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task)
    );
  }));

  ctx.onDispose(async () => {
    for (const request of requests) request.abort();
    const closed = new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
          reject(error);
        else resolve();
      });
    });
    listener.closeAllConnections();
    await Promise.all([closed, Promise.allSettled([...tasks])]);
  });

  ctx.signal.throwIfAborted();
  try {
    await new Promise<void>((resolve, reject) => {
      const aborted = () => {
        listener.close();
        finish(new Error("SSE_START_ABORTED"));
      };
      const failed = (error: Error) => finish(error);
      const finish = (error?: Error) => {
        ctx.signal.removeEventListener("abort", aborted);
        listener.off("error", failed);
        if (error) reject(error);
        else resolve();
      };
      ctx.signal.addEventListener("abort", aborted, { once: true });
      listener.once("error", failed);
      listener.listen(port as number, host as string, () => finish());
    });
  } catch (error) {
    ctx.signal.throwIfAborted();
    errors.push(
      error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? "SSE_ADDRESS_IN_USE"
        : "SSE_LISTEN_FAILED"
    );
    return;
  }
  // A server error after startup must not become an unhandled EventEmitter error.
  listener.on("error", () => {
    errors.push("SSE_LISTEN_FAILED");
    listener.close();
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const controller = new AbortController();
    const aborted = () => controller.abort();
    res.once("close", aborted);
    req.once("aborted", aborted);
    ctx.signal.addEventListener("abort", aborted, { once: true });
    requests.add(controller);
    try {
      if (ctx.signal.aborted) return jsonError(res, 503, "EXTRA_STOPPING");
      const authorization = Buffer.from(req.headers.authorization ?? "");
      if (authorization.length !== expected.length || !timingSafeEqual(authorization, expected)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return jsonError(res, 401, "UNAUTHORIZED");
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return jsonError(res, 405, "POST_REQUIRED");
      }
      let body = Buffer.alloc(0);
      let size = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        const bytes = chunk as Buffer;
        const nextSize = size + bytes.length;
        if (tooLarge || nextSize > INVOKE_REQUEST_MAX_BYTES) {
          if (!tooLarge) {
            tooLarge = true;
            body = Buffer.alloc(0);
            const discardTimer = setTimeout(() => req.destroy(), 5000);
            discardTimer.unref();
            req.once("end", () => clearTimeout(discardTimer));
            req.once("close", () => clearTimeout(discardTimer));
          }
          continue;
        }
        if (nextSize > body.length) {
          const expanded = Buffer.allocUnsafe(Math.min(INVOKE_REQUEST_MAX_BYTES, Math.max(65536, body.length * 2, nextSize)));
          body.copy(expanded, 0, 0, size);
          body = expanded;
        }
        bytes.copy(body, size);
        size = nextSize;
      }
      if (tooLarge) return jsonError(res, 413, "INVOKE_REQUEST_TOO_LARGE");
      let payload: InvokeInput;
      try {
        payload = InvokeInput.check(JSON.parse(body.toString("utf8", 0, size)));
        body = Buffer.alloc(0);
      } catch {
        return jsonError(res, 400, "INVALID_INVOKE_PAYLOAD");
      }
      controller.signal.throwIfAborted();
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache"
      });
      res.flushHeaders();
      const stream = Readable.from(
        (async function* () {
          try {
            for await (const event of ctx.adapterHost.invoke(payload, {
              signal: controller.signal
            })) {
              yield `data: ${JSON.stringify(event)}\n\n`;
            }
          } catch {
            if (!controller.signal.aborted)
              yield 'event: error\ndata: {"code":"HOST_INVOKE_FAILED"}\n\n';
          }
        })()
      );
      await pipeline(stream, res, { signal: controller.signal });
    } catch {
      if (!res.headersSent && !res.destroyed) jsonError(res, 400, "REQUEST_INTERRUPTED");
      else res.destroy();
    } finally {
      controller.abort();
      requests.delete(controller);
      ctx.signal.removeEventListener("abort", aborted);
      req.off("aborted", aborted);
      res.off("close", aborted);
    }
  }
}

function jsonError(res: ServerResponse, status: number, code: string): void {
  res.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
  res.end(JSON.stringify({ error: code }));
}
