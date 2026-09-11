import { randomInt, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { LIVE_EVENT_SOURCES, type LiveEventBus, type LiveEventSource } from "./live-event-bus.js";

const DEFAULT_HOST = "127.0.0.1";
const MIN_RANDOM_PORT = 20_001;
const MAX_ATTEMPTS = 32;
const MAX_LOG_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface InspectServerOptions {
  host?: string;
  port?: number;
}

export class InspectServer {
  readonly #events: LiveEventBus;
  readonly #status: () => unknown;
  readonly #logs: (runId?: string) => Promise<unknown>;
  readonly #host: string;
  readonly #port?: number;
  #server?: Server;
  #websocket?: WebSocketServer;
  #url?: string;
  #opening?: Promise<string>;
  #logRequestActive = false;

  constructor(
    events: LiveEventBus,
    status: () => unknown,
    logs: (runId?: string) => Promise<unknown>,
    options: InspectServerOptions = {}
  ) {
    this.#events = events;
    this.#status = status;
    this.#logs = logs;
    this.#host = options.host ?? DEFAULT_HOST;
    this.#port = options.port;
    if (!this.#host.trim()) throw new Error("inspect host cannot be empty");
    if (this.#port !== undefined && (!Number.isSafeInteger(this.#port) || this.#port < 1 || this.#port > 65_535)) {
      throw new Error("inspect port must be an integer between 1 and 65535");
    }
  }

  get url(): string | undefined { return this.#url; }

  async open(): Promise<string> {
    if (this.#url) return this.#url;
    if (!this.#opening) {
      this.#opening = this.#start().finally(() => { this.#opening = undefined; });
    }
    return this.#opening;
  }

  async #start(): Promise<string> {
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
        void this.#logs(url.searchParams.get("runId") || undefined).then(logs => {
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
      if (request.method === "GET" && url.pathname === "/help") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(inspectHelpHtml());
        return;
      }
      if (request.method !== "GET" || url.pathname !== "/") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(inspectHtml());
    });
    server.on("upgrade", (request, socket, head) => {
      const address = server.address();
      if (!address || typeof address === "string") return socket.destroy();
      const authority = acceptedAuthority(host, address.port, request.headers.host);
      if (!authority) return socket.destroy();
      const expectedOrigin = `http://${authority}`;
      const url = new URL(request.url ?? "/", expectedOrigin);
      if (request.headers.origin !== expectedOrigin
        || url.pathname !== "/events"
        || url.searchParams.get("token") !== capability) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      websocket.handleUpgrade(request, socket, head, client => websocket.emit("connection", client, request));
    });
    websocket.on("connection", (client, request) => {
      const address = server.address();
      if (!address || typeof address === "string") return client.close();
      const url = new URL(request.url ?? "/", `http://${urlAuthority(host, address.port)}`);
      const runId = url.searchParams.get("runId") || undefined;
      const sourceValue = url.searchParams.get("source") || undefined;
      const source = isSource(sourceValue) ? sourceValue : undefined;
      client.send(JSON.stringify({ kind: "status", status: this.#status(), memory: this.#events.stats }));
      const controller = new AbortController();
      client.once("close", () => controller.abort());
      void (async () => {
        try {
          for await (const event of this.#events.subscribeBytes({ runId, source }, true, controller.signal)) {
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
        this.#url = `http://${urlAuthority(host, port)}/?token=${encodeURIComponent(capability)}`;
        return this.#url;
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
    if (this.#opening) {
      try { await this.#opening; } catch { /* A failed open owns no resources. */ }
    }
    const server = this.#server;
    const websocket = this.#websocket;
    this.#server = undefined;
    this.#websocket = undefined;
    this.#url = undefined;
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
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
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

function inspectHelpHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Octo Harness Inspect 帮助</title><style>
  :root{color-scheme:light;--paper:#fff;--side:#eef1ef;--line:#dce1de;--ink:#202623;--muted:#626c67;--blue:#2563a8}*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 Inter,"Segoe UI",sans-serif}header{height:52px;display:flex;align-items:center;padding:0 22px;border-bottom:1px solid var(--line)}header a{color:var(--blue);text-decoration:none}header strong{margin-left:16px;font-size:14px}.layout{display:grid;grid-template-columns:240px minmax(0,760px);gap:48px;max-width:1120px;margin:0 auto;padding:38px 28px 72px}nav{position:sticky;top:24px;align-self:start;padding:16px 0;border-top:1px solid var(--line)}nav a{display:block;padding:6px 0;color:var(--muted);text-decoration:none}nav a:hover,nav a:focus-visible{color:var(--blue)}main h1{margin:0 0 8px;font-size:28px;line-height:1.2}main h2{margin:42px 0 10px;padding-top:8px;border-top:1px solid var(--line);font-size:18px}main h3{margin:24px 0 4px;font-size:14px}p{margin:7px 0;color:var(--muted)}code{color:var(--blue);font-family:"SFMono-Regular",Consolas,monospace}.flow{padding:14px 16px;border:1px solid var(--line);background:#f7f8f7;color:#35403a;font-family:"SFMono-Regular",Consolas,monospace}.term{display:grid;grid-template-columns:170px 1fr;gap:16px;padding:13px 0;border-bottom:1px solid var(--line)}.term strong{font-family:"SFMono-Regular",Consolas,monospace;font-size:12px}.term p{margin:0}@media(max-width:760px){.layout{grid-template-columns:1fr;padding:24px 18px}.layout nav{position:static}.term{grid-template-columns:1fr;gap:3px}}
  </style></head><body><header><a href="/">← 返回 Inspect</a><strong>诊断文档</strong></header><div class="layout"><nav aria-label="页内导航"><a href="#streams">Events 与 Logs</a><a href="#sources">事件来源</a><a href="#pipeline">规范化链路</a><a href="#memory">内存边界</a></nav><main><h1>Inspect 事件来源</h1><p>这是一份独立的调试参考。Inspect 主页面只保留实时观察和过滤控件，不随文档增长而变重。</p><h2 id="streams">Events 与 Logs</h2><div class="term"><strong>Events</strong><p>daemon 进程内的实时、有界诊断流。它用于观察正在发生的事件，超过 ring buffer 容量后会淘汰旧帧。</p></div><div class="term"><strong>Logs</strong><p>写入磁盘的持久运行记录，可在 Inspect 中读取最新的有界快照。它不是 AgentRun 的完整业务轨迹。</p></div><h2 id="sources">事件来源</h2><div class="term"><strong>daemon</strong><p>守护进程生命周期、执行状态和业务运行记录。</p></div><div class="term"><strong>adapter-rpc</strong><p>daemon 与 adapter-host 之间经过凭据脱敏的 RPC 帧。这是 Harness 边界名称，不是 Provider 原协议名称。</p></div><div class="term"><strong>provider-native</strong><p>Codex、Claude Code 等 Provider 产生、尚未规范化的原生事件。</p></div><div class="term"><strong>adapter-canonical</strong><p>Adapter 把 Provider 原生事件转换为 CanonicalEvent 后的结果。</p></div><div class="term"><strong>host-canonical</strong><p>adapter-host 对 CanonicalEvent 完成协议校验后的输出。</p></div><div class="term"><strong>runtime</strong><p>Agent Work Runtime 的连接、投递和背压状态。</p></div><div class="term"><strong>worker</strong><p>Worker 消息通道上的协议事件。</p></div><div class="term"><strong>control</strong><p>EventBus 产生的丢帧、序号缺口和来源不可用等诊断事件。</p></div><h2 id="pipeline">规范化链路</h2><p class="flow">provider-native → adapter-canonical → host-canonical</p><p><code>adapter-rpc</code> 从边界视角观察请求与响应；它与上面的语义转换链路不是同一个分类维度。</p><h2 id="memory">内存边界</h2><p>daemon EventBus 全局保留约 6 MiB，单帧最多 256 KiB；浏览器 Events 与 Logs 合计最多 1000 行、约 2 MiB 文本；AgentRuns 只保存最近 100 个轻量索引。</p></main></div></body></html>`;
}

function inspectHtml(): string {
  const sourceLabels: Record<LiveEventSource, string> = {
    daemon: "守护进程",
    "provider-native": "Provider 原生事件",
    "adapter-canonical": "Adapter 规范化",
    "host-canonical": "Host 校验后",
    "adapter-rpc": "适配器 RPC",
    runtime: "运行时内部",
    worker: "Worker 通道",
    control: "诊断控制"
  };
  const sourceOptions = LIVE_EVENT_SOURCES
    .map(source => `<option value="${source}">${sourceLabels[source]} · ${source}</option>`)
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Octo Harness Inspect</title><style>
  :root{color-scheme:light;--bg:#f7f8f7;--side:#eef1ef;--paper:#fff;--line:#dce1de;--line-strong:#c5cdc8;--ink:#202623;--muted:#707a75;--green:#087a55;--blue:#2563a8;--violet:#7650a5;--amber:#8b5b00;--red:#aa3e35}*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 Inter,"Segoe UI",sans-serif;overflow:hidden}button,input,select{font:inherit}button{color:inherit}header{height:52px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid var(--line-strong);background:var(--paper)}header strong{font-size:14px}.state{color:var(--green)}.state.error{color:var(--red)}.memory{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}.icon-button{display:inline-grid;place-items:center;width:30px;height:30px;text-decoration:none;border:1px solid var(--line-strong);background:var(--paper);cursor:pointer}.icon-button:hover,.icon-button:focus-visible{border-color:var(--blue);outline:2px solid #b9d5ee;outline-offset:1px}.auth{display:none;align-items:center;gap:10px;min-height:48px;padding:7px 16px;border-bottom:1px solid #d7b0aa;background:#fff5f3;color:#702b25}.auth.visible{display:flex}.auth input{width:min(420px,45vw);margin:0}.auth button{height:34px;padding:0 14px;border:1px solid #8e3c34;background:#8e3c34;color:#fff;cursor:pointer}main{display:grid;grid-template-columns:210px minmax(0,1fr) 260px;height:calc(100vh - 52px)}body.auth-needed main{height:calc(100vh - 100px)}aside{padding:14px;border-right:1px solid var(--line-strong);background:var(--side);overflow:auto}nav{display:grid;gap:3px;margin-bottom:18px}nav button{height:33px;padding:0 9px;text-align:left;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer}nav button:hover,nav button:focus-visible{border-color:#9fa9a3;outline:0}nav button.active{border-color:var(--line-strong);background:var(--paper);color:var(--ink);font-weight:600}label{display:block;color:var(--muted);margin:0 0 12px}input,select{width:100%;height:34px;margin-top:5px;padding:6px 8px;background:var(--paper);color:var(--ink);border:1px solid var(--line-strong)}input:focus-visible,select:focus-visible{outline:2px solid #b9d5ee;border-color:var(--blue)}.source-help{display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--muted);background:transparent;border:0;padding:3px 0;cursor:pointer}.source-help .icon-button{display:inline-grid;place-items:center;width:24px;height:24px}.view{grid-column:2;grid-row:1;height:100%;overflow:auto;background:var(--paper)}.view.hidden{display:none}.stream-head,.event-line{display:grid;grid-template-columns:24px 136px minmax(180px,1fr) 150px 62px 92px;align-items:center}.stream-head{position:sticky;top:0;z-index:2;height:34px;padding:0 12px;border-bottom:1px solid var(--line-strong);background:#f2f4f3;color:var(--muted);font-size:11px;font-weight:650;text-transform:uppercase}.records{margin:0;padding:0;list-style:none}.event{border-bottom:1px solid var(--line)}.event-line{width:100%;min-height:42px;padding:0 12px;border:0;background:transparent;text-align:left;cursor:pointer}.event-line:hover{background:#f6f8f7}.chevron::before{content:'›';display:block;color:#929b96;font-size:20px;line-height:1;transition:transform .12s}.event.open .chevron::before{transform:rotate(90deg)}.source{justify-self:start;max-width:126px;padding:3px 7px;background:#eaf2f9;color:var(--blue);font-size:11px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event[data-source="adapter-rpc"] .source{background:#f1ebf7;color:var(--violet)}.event[data-source="provider-native"] .source{background:#fff2d8;color:var(--amber)}.event[data-source="adapter-canonical"] .source{background:#e9effc;color:#365fb3}.event[data-source="host-canonical"] .source{background:#e5f3ed;color:var(--green)}.event[data-source="control"] .source{background:#faeae8;color:var(--red)}.event-main{min-width:0;padding:0 10px}.type{display:block;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary{display:block;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px/1.35 "SFMono-Regular",Consolas,monospace}.run-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4f5b55;font:11px "SFMono-Regular",Consolas,monospace}.seq,.time{color:#8a938e;font-variant-numeric:tabular-nums;text-align:right}.detail{display:none;margin:0 12px 12px 172px;padding:14px;border:1px solid var(--line);background:#fafbfa;color:#35403a;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 "SFMono-Regular",Consolas,monospace}.event.open .detail{display:block}.json-view{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:#35403a;font:12px/1.55 "SFMono-Regular",Consolas,monospace}.run-panel{grid-column:3;grid-row:1;border-left:1px solid var(--line-strong);background:var(--side);overflow:auto}.panel-title{position:sticky;top:0;z-index:2;height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--line-strong);background:#e8ece9;font-size:11px;text-transform:uppercase}.run-count{color:var(--muted);font-variant-numeric:tabular-nums}.run-list{list-style:none;margin:0;padding:0}.run-item button{width:100%;padding:9px 12px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}.run-item button:hover,.run-item button:focus-visible{background:var(--paper);outline:0}.run-id{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px "SFMono-Regular",Consolas,monospace}.run-meta{display:flex;justify-content:space-between;margin-top:3px;color:var(--muted);font-size:11px}@media(max-width:980px){main{grid-template-columns:190px minmax(0,1fr)}.run-panel{display:none}.stream-head,.event-line{grid-template-columns:24px 126px minmax(160px,1fr) 72px}.run-cell,.seq{display:none}}@media(max-width:680px){header{padding:0 10px;gap:9px}.memory{font-size:10px}.auth{flex-wrap:wrap;padding:8px 10px}.auth strong{width:100%}.auth input{flex:1;width:auto;min-width:0}body.auth-needed main{height:calc(100vh - 124px)}main{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}aside{grid-column:1;grid-row:1;padding:9px;border-right:0;border-bottom:1px solid var(--line-strong)}nav{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:8px}nav button{text-align:center;padding:0 3px;font-size:11px}aside label{display:inline-block;width:calc(50% - 5px);margin:0 5px 0 0}.source-help{display:none}.view{grid-column:1;grid-row:2}.stream-head,.event-line{grid-template-columns:20px 88px minmax(100px,1fr) 68px;padding-left:8px;padding-right:8px}.source{max-width:82px;padding:2px 4px}.detail{margin:0 8px 8px 28px;padding:10px;font-size:11px}}
  </style></head><body><header><strong>Octo Harness Inspect</strong><span class="state" id="state" aria-live="polite">connecting</span><span class="memory" id="memory"></span><a class="icon-button" id="about" href="/help" title="事件来源说明" aria-label="事件来源说明">?</a></header><form class="auth" id="auth"><strong id="auth-message">需要 Capability Token</strong><input id="token" type="password" autocomplete="off" spellcheck="false" aria-label="Capability token" placeholder="粘贴 token 或完整 inspect URL"><button type="submit">连接</button></form><main><aside><nav><button class="active" data-view="events">事件</button><button data-view="logs">持久日志</button><button data-view="runtime">运行时</button><button data-view="memory">内存</button></nav><label>Agent Run ID<input id="run" placeholder="全部运行"></label><label>来源<select id="source"><option value="">全部来源</option>${sourceOptions}</select></label><a class="source-help" id="source-help" href="/help"><span class="icon-button">?</span>这些来源有什么区别</a></aside><section class="view stream" id="events"><div class="stream-head"><span></span><span>来源</span><span>事件</span><span class="run-cell">Agent Run</span><span class="seq">序号</span><span class="time">时间</span></div><ol class="records" id="event-records"></ol></section><section class="view stream hidden" id="logs"><div class="stream-head"><span></span><span>组件</span><span>日志</span><span class="run-cell">Agent Run</span><span class="seq">序号</span><span class="time">时间</span></div><ol class="records" id="log-records"></ol></section><pre class="view json-view hidden" id="runtime"></pre><pre class="view json-view hidden" id="memory-view"></pre><section class="run-panel"><div class="panel-title"><span>AgentRuns</span><span class="run-count" id="run-count">0 / 100</span></div><ol class="run-list" id="run-list"></ol></section></main><script>
  const sourceLabels=${JSON.stringify(sourceLabels)},MAX_ROWS=1000,DOM_BYTES=2*1024*1024,MAX_RUNS=100,tokenKey='octo-harness.inspect.token:'+location.host,queryToken=new URLSearchParams(location.search).get('token')||'',run=document.querySelector('#run'),source=document.querySelector('#source'),state=document.querySelector('#state'),memory=document.querySelector('#memory'),events=document.querySelector('#event-records'),logs=document.querySelector('#log-records'),runtime=document.querySelector('#runtime'),memoryView=document.querySelector('#memory-view'),auth=document.querySelector('#auth'),authMessage=document.querySelector('#auth-message'),tokenInput=document.querySelector('#token'),runList=document.querySelector('#run-list'),runCount=document.querySelector('#run-count');let token=queryToken||sessionStorage.getItem(tokenKey)||'',ws,serverMemory={},domOrder=0;if(queryToken)sessionStorage.setItem(tokenKey,queryToken);tokenInput.value=token;history.replaceState(null,'',location.pathname);
  function textSummary(value){if(value&&typeof value==='object'){for(const key of ['message','text','delta','command','name'])if(typeof value[key]==='string')return value[key].replace(/\\s+/g,' ').slice(0,240)}return JSON.stringify(value).replace(/\\s+/g,' ').slice(0,240)}function clock(value){const date=new Date(value);return Number.isNaN(date.valueOf())?'—':date.toLocaleTimeString([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3})}function trimRows(){let count=events.children.length+logs.children.length,bytes=Number(events.dataset.bytes||0)+Number(logs.dataset.bytes||0);while(count>MAX_ROWS||bytes>DOM_BYTES){const first=[events.firstElementChild,logs.firstElementChild].filter(Boolean).sort((a,b)=>Number(a.dataset.order)-Number(b.dataset.order))[0];if(!first)break;const target=first.parentElement,size=Number(first.dataset.bytes||0);target.dataset.bytes=String(Math.max(0,Number(target.dataset.bytes||0)-size));bytes-=size;count-=1;first.remove()}}function row(target,item,durable=false){const sourceName=durable?(item.component||'log'):item.source,name=durable?item.event:item.type,runId=durable?item.run_id:item.agent_run_id,seq=durable?'—':('#'+item.local_seq),time=durable?item.ts:item.occurred_at,payload=durable?item:item.payload,pretty=JSON.stringify(item,null,2),summary=textSummary(payload),li=document.createElement('li');li.className='event';li.dataset.source=sourceName;li.dataset.order=String(++domOrder);li.dataset.bytes=String((pretty.length+summary.length+String(runId||'').length)*2);li.dataset.runId=runId||'';li.dataset.eventType=name||'';li.dataset.affectedSource=durable?'':(item.payload?.affected_source||'');li.innerHTML='<button class="event-line" type="button" aria-expanded="false"><span class="chevron"></span><span class="source"></span><span class="event-main"><span class="type"></span><span class="summary"></span></span><span class="run-cell"></span><span class="seq"></span><time class="time"></time></button><pre class="detail"></pre>';const cells=li.querySelectorAll('.source,.type,.summary,.run-cell,.seq,.time,.detail');cells[0].textContent=durable?sourceName:(sourceLabels[sourceName]||sourceName);cells[1].textContent=name||'unknown';cells[2].textContent=summary;cells[3].textContent=runId||'—';cells[4].textContent=seq;cells[5].textContent=clock(time);cells[6].textContent=pretty;li.firstElementChild.onclick=()=>{li.classList.toggle('open');li.firstElementChild.setAttribute('aria-expanded',String(li.classList.contains('open')))};target.append(li);target.dataset.bytes=String(Number(target.dataset.bytes||0)+Number(li.dataset.bytes));trimRows();const viewport=target.closest('.stream');viewport.scrollTop=viewport.scrollHeight;applyFilters()}
  function requireToken(message){state.textContent='token required';state.classList.add('error');authMessage.textContent=message;auth.classList.add('visible');document.body.classList.add('auth-needed')}
  function acceptToken(){state.classList.remove('error');auth.classList.remove('visible');document.body.classList.remove('auth-needed')}
  function renderMemory(){memoryView.textContent=JSON.stringify({...serverMemory,browserDomBudgetBytes:DOM_BYTES,browserDomBytes:Number(events.dataset.bytes||0)+Number(logs.dataset.bytes||0),browserRows:events.children.length+logs.children.length,agentRuns:runList.children.length},null,2)}function trackRun(item){const id=item.agent_run_id;if(!id)return;let li=runList.querySelector('[data-run-id="'+CSS.escape(id)+'"]');if(!li){li=document.createElement('li');li.className='run-item';li.dataset.runId=id;li.innerHTML='<button type="button"><span class="run-id"></span><span class="run-meta"><span class="run-type"></span><time></time></span></button>';li.querySelector('button').onclick=()=>{run.value=id;applyFilters()}}li.querySelector('.run-id').textContent=id;li.querySelector('.run-type').textContent=item.type;li.querySelector('time').textContent=clock(item.occurred_at);runList.prepend(li);while(runList.children.length>MAX_RUNS)runList.lastElementChild.remove();runCount.textContent=runList.children.length+' / '+MAX_RUNS;renderMemory()}
  function connect(){if(!token){requireToken('Capability token 缺失');return}events.replaceChildren();events.dataset.bytes='0';const q=new URLSearchParams({token});ws?.close();const protocol=location.protocol==='https:'?'wss://':'ws://',current=new WebSocket(protocol+location.host+'/events?'+q);ws=current;let opened=false;current.onopen=()=>{opened=true;state.textContent='实时';acceptToken()};current.onerror=()=>{if(!opened&&ws===current)requireToken('Capability token 缺失或无效')};current.onclose=()=>{if(ws!==current)return;if(!opened)requireToken('Capability token 缺失或无效');else state.textContent='已断开'};current.onmessage=message=>{const body=JSON.parse(message.data);if(body.kind==='status'){serverMemory=body.memory;memory.textContent=Math.round(body.memory.retainedBytes/1024)+' KiB · '+body.memory.retainedEvents+' 条';runtime.textContent=JSON.stringify(body.status,null,2);renderMemory();return}trackRun(body);row(events,body);renderMemory()}}
  let logsLoaded=false;async function loadLogs(){if(logsLoaded){applyFilters();return}if(!token){requireToken('Capability token 缺失');return}const response=await fetch('/api/logs',{headers:{Authorization:'Bearer '+token}});if(response.status===401){requireToken('Capability token 缺失或无效');return}if(response.status===429)return;const body=await response.json();logs.replaceChildren();logs.dataset.bytes='0';for(const item of body)row(logs,item,true);logsLoaded=true;applyFilters()}
  function enteredToken(value){try{const parsed=new URL(value);return parsed.searchParams.get('token')||''}catch{return value.replace(/^\\?token=/,'')}}auth.onsubmit=event=>{event.preventDefault();token=enteredToken(tokenInput.value.trim());if(!token){requireToken('请输入 Capability token');return}sessionStorage.setItem(tokenKey,token);tokenInput.value=token;connect()};document.querySelectorAll('nav button').forEach(button=>button.onclick=()=>{document.querySelectorAll('nav button').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.view').forEach(item=>item.classList.add('hidden'));document.querySelector('#'+(button.dataset.view==='memory'?'memory-view':button.dataset.view)).classList.remove('hidden');if(button.dataset.view==='logs')void loadLogs()});connect();
  </script><style>.seq,.time{color:#626c67}.chevron::before{color:#69736e}.event[hidden]{display:none}.run-item.selected button{background:#fff;box-shadow:inset 2px 0 #2563a8}.source-help{text-decoration:none}</style><script>
  function applyFilters(){const runId=run.value.trim(),selectedSource=source.value;for(const item of events.children){const runMatches=!runId||item.dataset.runId===runId||item.dataset.eventType==='bus.gap'||item.dataset.eventType==='bus.correlation_gap',sourceMatches=!selectedSource||item.dataset.source===selectedSource||(item.dataset.source==='control'&&item.dataset.affectedSource===selectedSource);item.hidden=!(runMatches&&sourceMatches)}for(const item of logs.children)item.hidden=Boolean(runId&&item.dataset.runId!==runId);for(const item of runList.children)item.classList.toggle('selected',Boolean(runId&&item.dataset.runId===runId))}
  run.oninput=applyFilters;run.onchange=applyFilters;source.onchange=applyFilters;
  </script></body></html>`;
  return html;
}
