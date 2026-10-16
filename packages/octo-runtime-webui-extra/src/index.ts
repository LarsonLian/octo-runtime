import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdir, realpath, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, isAbsolute, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  InvokeInput,
  INVOKE_REQUEST_MAX_BYTES,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type { ExtraContext, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
import { SessionStore, validMessages, validBinding, type Session } from "./store.js";

export const name = "webui";
export default async function load(ctx: ExtraContext, config: JsonObject): Promise<void> {
  const configuredPort = config.port ?? 13888;
  const port = typeof configuredPort === "number" ? configuredPort : 0;
  const host = "127.0.0.1";
  const errors: string[] = [];
  const active = new Map<
    string,
    { sessionId: string; controller: AbortController; done: Promise<void> }
  >();
  const tasks = new Set<Promise<void>>();
  const deleting = new Set<string>();
  let clearing = false;
  const secret = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    const task = handle(req, res).catch((error) => {
      if (res.headersSent) res.destroy();
      else
        json(res, error instanceof HttpError ? error.status : 500, {
          error:
            error instanceof HttpError
              ? error.message
              : error instanceof Error && error.message === "WEBUI_STORE_TOO_LARGE"
                ? "WEBUI_STORE_TOO_LARGE"
                : "WEBUI_REQUEST_FAILED"
        });
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  ctx.onStatus(() => ({
    listening: server.listening,
    host,
    port: typeof port === "number" ? port : 13888,
    activeRequests: active.size,
    errors
  }));
  ctx.onDispose(async () => {
    for (const run of active.values()) run.controller.abort();
    const closed = new Promise<void>((accept, reject) =>
      server.close((error) =>
        !error || (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
          ? accept()
          : reject(error)
      )
    );
    server.closeAllConnections();
    await Promise.all([closed, ...tasks]);
  });
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) {
    errors.push("WEBUI_PORT_INVALID");
    return;
  }
  if (typeof config.sessionStorePath !== "string" || !isAbsolute(config.sessionStorePath)) {
    errors.push("WEBUI_STORE_PATH_REQUIRED");
    return;
  }
  const store = new SessionStore(config.sessionStorePath);
  try {
    await store.open();
  } catch {
    errors.push("WEBUI_STORE_INVALID");
    return;
  }
  const defaultProject =
    typeof config.defaultProjectPath === "string"
      ? resolve(config.defaultProjectPath)
      : join(homedir(), "octo-runtime-workspace");
  await mkdir(defaultProject, { recursive: true });
  const defaultProjectPath = await realpath(defaultProject);
  const staticRoot = fileURLToPath(new URL("./web/", import.meta.url));
  ctx.signal.throwIfAborted();
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        accept();
      });
    });
  } catch (error) {
    errors.push(
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? "WEBUI_ADDRESS_IN_USE"
        : "WEBUI_LISTEN_FAILED"
    );
    return;
  }
  server.on("error", () => {
    errors.push("WEBUI_LISTEN_FAILED");
    server.close();
  });
  const origin = `http://${host}:${port}`;

  async function stop(sessionId?: string) {
    const runs = [...active.values()].filter((run) => !sessionId || run.sessionId === sessionId);
    for (const run of runs) run.controller.abort();
    await Promise.all(runs.map((run) => run.done));
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.headers.host !== `${host}:${port}` || req.headers["sec-fetch-site"] === "cross-site")
      throw new HttpError(403, "WEBUI_ORIGIN_REJECTED");
    const url = new URL(req.url ?? "/", origin);
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") throw new HttpError(405, "GET_REQUIRED");
      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(path))
        throw new HttpError(404, "NOT_FOUND");
      let bytes: Buffer;
      try {
        bytes = await readFile(join(staticRoot, path));
      } catch {
        throw new HttpError(404, "NOT_FOUND");
      }
      if (path === "index.html")
        res.setHeader("Set-Cookie", `octo_webui=${secret}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript",
            ".css": "text/css"
          } as Record<string, string>
        )[extname(path)] ?? "application/octet-stream"
      );
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
      );
      res.end(bytes);
      return;
    }
    if (!req.headers.cookie?.split(";").some((value) => value.trim() === `octo_webui=${secret}`))
      throw new HttpError(401, "WEBUI_SESSION_REQUIRED");
    if (
      req.method !== "GET" &&
      (req.headers.origin !== origin || req.headers["x-webui-token"] !== secret)
    )
      throw new HttpError(403, "WEBUI_ORIGIN_REJECTED");
    if (req.method === "GET" && url.pathname === "/api/bootstrap")
      return json(res, 200, { token: secret, defaultProjectPath });
    if (req.method === "GET" && url.pathname === "/api/adapters") {
      if (!ctx.adapterHost.list) throw new HttpError(503, "ADAPTER_LIST_UNAVAILABLE");
      const adapters = await ctx.adapterHost.list();
      return json(
        res,
        200,
        adapters.map((adapter) => ({
          providerType: adapter.type,
          available: adapter.available === true,
          providerVersion: adapter.providerVersion,
          unavailableReason: adapter.unavailableReason
        }))
      );
    }
    if (req.method === "GET" && url.pathname === "/api/directories") {
      const path = await directory(url.searchParams.get("path") ?? defaultProjectPath);
      const entries = await readdir(path, { withFileTypes: true });
      return json(res, 200, {
        path,
        parent: resolve(path, ".."),
        directories: entries
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
          .map((entry) => ({ name: entry.name, path: join(path, entry.name) }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 1000)
      });
    }
    if (req.method === "GET" && url.pathname === "/api/sessions")
      return json(
        res,
        200,
        [...store.records]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((session) => ({
            id: session.id,
            title: session.title,
            projectPath: session.projectPath,
            adapter: session.adapter,
            model: session.model,
            effort: session.effort,
            revision: session.revision,
            updatedAt: session.updatedAt,
            active: [...active.values()].some((run) => run.sessionId === session.id)
          }))
      );
    const match = /^\/api\/sessions\/([a-f0-9-]+)$/.exec(url.pathname);
    if (match && req.method === "GET") return json(res, 200, find(match[1]));
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      if (clearing) throw new HttpError(409, "WEBUI_CLEARING");
      const body = await bodyJson(req);
      const projectPath = await directory(
        typeof body.projectPath === "string" ? body.projectPath : defaultProjectPath
      );
      const session: Session = {
        id: randomUUID(),
        projectPath,
        title: "新对话",
        updatedAt: Date.now(),
        revision: 0,
        adapter: "",
        model: "",
        effort: "medium",
        messages: []
      };
      await store.change((records) => {
        if (records.length >= 100) {
          const candidate = [...records]
            .filter((s) => ![...active.values()].some((run) => run.sessionId === s.id))
            .sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (!candidate) throw new HttpError(409, "WEBUI_SESSIONS_BUSY");
          records.splice(
            records.findIndex((s) => s.id === candidate.id),
            1
          );
        }
        records.push(session);
      });
      return json(res, 201, session);
    }
    if (match && req.method === "PATCH") {
      const id = match[1];
      if (clearing || deleting.has(id)) throw new HttpError(409, "WEBUI_CLEARING");
      const body = await bodyJson(req);
      if (
        !validMessages(body.messages) ||
        typeof body.title !== "string" ||
        body.title.length > 200 ||
        !["adapter", "model", "effort"].every(
          (key) => typeof body[key] === "string" && String(body[key]).length < 300
        )
      )
        throw new HttpError(400, "WEBUI_SESSION_INVALID");
      if (body.providerSession !== undefined && !validBinding(body.providerSession))
        throw new HttpError(400, "WEBUI_BINDING_INVALID");
      const result = await store.change((records) => {
        const session = records.find((s) => s.id === id);
        if (!session) throw new HttpError(404, "WEBUI_SESSION_NOT_FOUND");
        if (session.revision !== body.revision) throw new HttpError(409, "WEBUI_REVISION_CONFLICT");
        Object.assign(session, {
          messages: body.messages,
          title: body.title,
          adapter: body.adapter,
          model: body.model,
          effort: body.effort,
          ...(body.providerSession ? { providerSession: body.providerSession } : {}),
          updatedAt: Date.now(),
          revision: session.revision + 1
        });
        return session;
      });
      return json(res, 200, result);
    }
    if (req.method === "DELETE" && (match || url.pathname === "/api/sessions")) {
      const id = match?.[1];
      if (id) deleting.add(id);
      else clearing = true;
      try {
        await stop(id);
        await store.change((records) => {
          if (id) {
            const index = records.findIndex((s) => s.id === id);
            if (index >= 0) records.splice(index, 1);
          } else records.splice(0);
        });
        return json(res, 200, { cleared: true });
      } finally {
        if (id) deleting.delete(id);
        else clearing = false;
      }
    }
    if (req.method === "POST" && url.pathname === "/api/invoke") {
      let input: InvokeInput;
      try {
        input = InvokeInput.check(await bodyJson(req));
      } catch {
        throw new HttpError(400, "WEBUI_INVOKE_INVALID");
      }
      const session = find(input.sessionId ?? "");
      if (
        clearing ||
        deleting.has(session.id) ||
        active.size >= 4 ||
        [...active.values()].some((run) => run.sessionId === session.id)
      )
        throw new HttpError(409, "WEBUI_SESSION_BUSY");
      if (
        input.protocol_mode !== "canonical" ||
        (await directory(input.workdir ?? "")) !== session.projectPath ||
        !input.invocationId
      )
        throw new HttpError(400, "WEBUI_INVOKE_INVALID");
      if (
        clearing ||
        deleting.has(session.id) ||
        active.size >= 4 ||
        [...active.values()].some((run) => run.sessionId === session.id)
      )
        throw new HttpError(409, "WEBUI_SESSION_BUSY");
      if (JSON.stringify(input.providerSession) !== JSON.stringify(session.providerSession))
        throw new HttpError(409, "WEBUI_BINDING_CONFLICT");
      const id = input.invocationId;
      if (active.has(id)) throw new HttpError(409, "WEBUI_INVOCATION_EXISTS");
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      ctx.signal.addEventListener("abort", abort, { once: true });
      let finish!: () => void;
      const done = new Promise<void>((accept) => {
        finish = accept;
      });
      active.set(id, { sessionId: session.id, controller, done });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store"
      });
      res.flushHeaders();
      try {
        await pipeline(
          Readable.from(
            (async function* () {
              try {
                for await (const event of ctx.adapterHost.invoke(input, {
                  signal: controller.signal
                }))
                  yield `data: ${JSON.stringify(event)}\n\n`;
              } catch {
                if (!controller.signal.aborted)
                  yield 'event: error\ndata: {"error":"HOST_INVOKE_FAILED"}\n\n';
              }
            })()
          ),
          res,
          { signal: controller.signal }
        );
      } catch {
        res.destroy();
      } finally {
        controller.abort();
        active.delete(id);
        res.off("close", abort);
        ctx.signal.removeEventListener("abort", abort);
        finish();
      }
      return;
    }
    const runMatch = /^\/api\/invocations\/([a-f0-9-]+)\/(cancel|respond)$/.exec(url.pathname);
    if (req.method === "POST" && runMatch) {
      const run = active.get(runMatch[1]);
      if (!run) throw new HttpError(409, "WEBUI_INVOCATION_INACTIVE");
      if (runMatch[2] === "cancel") {
        await ctx.adapterHost.cancel(runMatch[1], "user");
        return json(res, 200, { requested: true });
      }
      await ctx.adapterHost.respondInteraction(
        runMatch[1],
        (await bodyJson(req)) as unknown as InteractionResponse
      );
      return json(res, 200, { submitted: true });
    }
    throw new HttpError(404, "NOT_FOUND");
  }
  function find(id: string) {
    const session = store.records.find((s) => s.id === id);
    if (!session) throw new HttpError(404, "WEBUI_SESSION_NOT_FOUND");
    return session;
  }
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    code: string
  ) {
    super(code);
  }
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(value));
}
async function directory(path: string) {
  try {
    if (!isAbsolute(path)) throw new Error();
    const result = await realpath(path);
    if (!(await stat(result)).isDirectory()) throw new Error();
    return result;
  } catch {
    throw new HttpError(400, "WEBUI_DIRECTORY_INVALID");
  }
}
async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > INVOKE_REQUEST_MAX_BYTES) throw new HttpError(413, "WEBUI_BODY_TOO_LARGE");
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "WEBUI_JSON_INVALID");
  }
}
