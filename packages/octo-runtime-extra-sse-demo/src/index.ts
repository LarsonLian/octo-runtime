import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  InvokeInput
} from "@mininglamp-oss/octo-runtime-protocol";
import { prepareInvokeInput } from "@mininglamp-oss/octo-runtime-core";
import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";

export const name = "sse-demo";
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Initializes once; HTTP routing, authentication and delivery belong to this extra. */
export default async function load(ctx: ExtraContext, config: JsonObject): Promise<void> {
  const { host = "127.0.0.1", port = 3002, token } = config;
  if (typeof host !== "string" || !isIP(host)) throw new Error("SSE_HOST_INVALID");
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("SSE_PORT_INVALID");
  if (typeof token !== "string" || !token || /\s/.test(token))
    throw new Error("SSE_TOKEN_REQUIRED");
  const expected = Buffer.from(`Bearer ${token}`);
  const requests = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const task = handle(req, res);
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      () => tasks.delete(task)
    );
  });

  ctx.onDispose(async () => {
    for (const request of requests) request.abort();
    const closed = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
          reject(error);
        else resolve();
      });
    });
    server.closeAllConnections();
    await Promise.all([closed, Promise.allSettled([...tasks])]);
  });

  ctx.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => {
      server.close();
      finish(new Error("SSE_START_ABORTED"));
    };
    const failed = (error: Error) => finish(error);
    const finish = (error?: Error) => {
      ctx.signal.removeEventListener("abort", aborted);
      server.off("error", failed);
      if (error) reject(error);
      else resolve();
    };
    ctx.signal.addEventListener("abort", aborted, { once: true });
    server.once("error", failed);
    server.listen(port, host, () => finish());
  });
  // A server error after startup must not become an unhandled EventEmitter error.
  server.on("error", () => {
    server.close();
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
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > MAX_BODY_BYTES) return jsonError(res, 413, "PAYLOAD_TOO_LARGE");
        chunks.push(bytes);
      }
      let payload: InvokeInput;
      try {
        payload = InvokeInput.check(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        prepareInvokeInput(payload);
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
            for await (const event of ctx.adapterHost.invoke(
              payload,
              { signal: controller.signal }
            )) {
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
