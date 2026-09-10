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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Octo Harness Inspect</title><style>
  :root{color-scheme:light;--bg:#f7f8f7;--side:#eef1ef;--paper:#fff;--line:#dce1de;--line-strong:#c5cdc8;--ink:#202623;--muted:#707a75;--green:#087a55;--blue:#2563a8;--violet:#7650a5;--amber:#8b5b00;--red:#aa3e35}*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 Inter,"Segoe UI",sans-serif;overflow:hidden}button,input,select{font:inherit}button{color:inherit}header{height:52px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid var(--line-strong);background:var(--paper)}header strong{font-size:14px}.state{color:var(--green)}.state.error{color:var(--red)}.memory{margin-left:auto;color:var(--muted);font-variant-numeric:tabular-nums}.icon-button{width:30px;height:30px;border:1px solid var(--line-strong);background:var(--paper);cursor:pointer}.icon-button:hover,.icon-button:focus-visible{border-color:var(--blue);outline:2px solid #b9d5ee;outline-offset:1px}.auth{display:none;align-items:center;gap:10px;min-height:48px;padding:7px 16px;border-bottom:1px solid #d7b0aa;background:#fff5f3;color:#702b25}.auth.visible{display:flex}.auth input{width:min(420px,45vw);margin:0}.auth button{height:34px;padding:0 14px;border:1px solid #8e3c34;background:#8e3c34;color:#fff;cursor:pointer}main{display:grid;grid-template-columns:210px minmax(0,1fr) 260px;height:calc(100vh - 52px)}body.auth-needed main{height:calc(100vh - 100px)}aside{padding:14px;border-right:1px solid var(--line-strong);background:var(--side);overflow:auto}nav{display:grid;gap:3px;margin-bottom:18px}nav button{height:33px;padding:0 9px;text-align:left;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer}nav button:hover,nav button:focus-visible{border-color:#9fa9a3;outline:0}nav button.active{border-color:var(--line-strong);background:var(--paper);color:var(--ink);font-weight:600}label{display:block;color:var(--muted);margin:0 0 12px}input,select{width:100%;height:34px;margin-top:5px;padding:6px 8px;background:var(--paper);color:var(--ink);border:1px solid var(--line-strong)}input:focus-visible,select:focus-visible{outline:2px solid #b9d5ee;border-color:var(--blue)}.source-help{display:flex;align-items:center;gap:8px;margin-top:4px;color:var(--muted);background:transparent;border:0;padding:3px 0;cursor:pointer}.source-help .icon-button{display:inline-grid;place-items:center;width:24px;height:24px}.view{grid-column:2;grid-row:1;height:100%;overflow:auto;background:var(--paper)}.view.hidden{display:none}.stream-head,.event-line{display:grid;grid-template-columns:24px 136px minmax(180px,1fr) 150px 62px 92px;align-items:center}.stream-head{position:sticky;top:0;z-index:2;height:34px;padding:0 12px;border-bottom:1px solid var(--line-strong);background:#f2f4f3;color:var(--muted);font-size:11px;font-weight:650;text-transform:uppercase}.records{margin:0;padding:0;list-style:none}.event{border-bottom:1px solid var(--line)}.event-line{width:100%;min-height:42px;padding:0 12px;border:0;background:transparent;text-align:left;cursor:pointer}.event-line:hover{background:#f6f8f7}.chevron::before{content:'›';display:block;color:#929b96;font-size:20px;line-height:1;transition:transform .12s}.event.open .chevron::before{transform:rotate(90deg)}.source{justify-self:start;max-width:126px;padding:3px 7px;background:#eaf2f9;color:var(--blue);font-size:11px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.event[data-source="adapter-rpc"] .source{background:#f1ebf7;color:var(--violet)}.event[data-source="provider-native"] .source{background:#fff2d8;color:var(--amber)}.event[data-source="adapter-canonical"] .source{background:#e9effc;color:#365fb3}.event[data-source="host-canonical"] .source{background:#e5f3ed;color:var(--green)}.event[data-source="control"] .source{background:#faeae8;color:var(--red)}.event-main{min-width:0;padding:0 10px}.type{display:block;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.summary{display:block;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font:11px/1.35 "SFMono-Regular",Consolas,monospace}.run-cell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4f5b55;font:11px "SFMono-Regular",Consolas,monospace}.seq,.time{color:#8a938e;font-variant-numeric:tabular-nums;text-align:right}.detail{display:none;margin:0 12px 12px 172px;padding:14px;border:1px solid var(--line);background:#fafbfa;color:#35403a;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.55 "SFMono-Regular",Consolas,monospace}.event.open .detail{display:block}.json-view{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:#35403a;font:12px/1.55 "SFMono-Regular",Consolas,monospace}.run-panel{grid-column:3;grid-row:1;border-left:1px solid var(--line-strong);background:var(--side);overflow:auto}.panel-title{position:sticky;top:0;z-index:2;height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;border-bottom:1px solid var(--line-strong);background:#e8ece9;font-size:11px;text-transform:uppercase}.run-count{color:var(--muted);font-variant-numeric:tabular-nums}.run-list{list-style:none;margin:0;padding:0}.run-item button{width:100%;padding:9px 12px;border:0;border-bottom:1px solid var(--line);background:transparent;text-align:left;cursor:pointer}.run-item button:hover,.run-item button:focus-visible{background:var(--paper);outline:0}.run-id{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px "SFMono-Regular",Consolas,monospace}.run-meta{display:flex;justify-content:space-between;margin-top:3px;color:var(--muted);font-size:11px}.drawer-backdrop{display:none;position:fixed;inset:0;z-index:8;background:rgba(25,31,28,.18)}.drawer-backdrop.open{display:block}.drawer{position:absolute;top:0;right:0;width:min(430px,92vw);height:100%;padding:18px 20px;background:var(--paper);border-left:1px solid var(--line-strong);box-shadow:-12px 0 30px rgba(20,30,25,.08);overflow:auto}.drawer header{height:auto;padding:0 0 14px;border:0}.drawer h2{font-size:16px;margin:0}.drawer dl{margin:0}.drawer dt{margin-top:15px;font-weight:700}.drawer dd{margin:3px 0 0;color:var(--muted)}.drawer code{color:var(--blue)}.drawer-note{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted)}@media(max-width:980px){main{grid-template-columns:190px minmax(0,1fr)}.run-panel{display:none}.stream-head,.event-line{grid-template-columns:24px 126px minmax(160px,1fr) 72px}.run-cell,.seq{display:none}}@media(max-width:680px){header{padding:0 10px;gap:9px}.memory{font-size:10px}.auth{flex-wrap:wrap;padding:8px 10px}.auth strong{width:100%}.auth input{flex:1;width:auto;min-width:0}body.auth-needed main{height:calc(100vh - 124px)}main{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}aside{grid-column:1;grid-row:1;padding:9px;border-right:0;border-bottom:1px solid var(--line-strong)}nav{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:8px}nav button{text-align:center;padding:0 3px;font-size:11px}aside label{display:inline-block;width:calc(50% - 5px);margin:0 5px 0 0}.source-help{display:none}.view{grid-column:1;grid-row:2}.stream-head,.event-line{grid-template-columns:20px 88px minmax(100px,1fr) 68px;padding-left:8px;padding-right:8px}.source{max-width:82px;padding:2px 4px}.detail{margin:0 8px 8px 28px;padding:10px;font-size:11px}}
  </style></head><body><header><strong>Octo Harness Inspect</strong><span class="state" id="state" aria-live="polite">connecting</span><span class="memory" id="memory"></span><button class="icon-button" id="about" title="事件来源说明" aria-label="事件来源说明">?</button></header><form class="auth" id="auth"><strong id="auth-message">需要 Capability Token</strong><input id="token" type="password" autocomplete="off" spellcheck="false" aria-label="Capability token" placeholder="粘贴 token 或完整 inspect URL"><button type="submit">连接</button></form><main><aside><nav><button class="active" data-view="events">事件</button><button data-view="logs">持久日志</button><button data-view="runtime">运行时</button><button data-view="memory">内存</button></nav><label>Agent Run ID<input id="run" placeholder="全部运行"></label><label>来源<select id="source"><option value="">全部来源</option>${sourceOptions}</select></label><button class="source-help" id="source-help"><span class="icon-button">?</span>这些来源有什么区别</button></aside><section class="view stream" id="events"><div class="stream-head"><span></span><span>来源</span><span>事件</span><span class="run-cell">Agent Run</span><span class="seq">序号</span><span class="time">时间</span></div><ol class="records" id="event-records"></ol></section><section class="view stream hidden" id="logs"><div class="stream-head"><span></span><span>组件</span><span>日志</span><span class="run-cell">Agent Run</span><span class="seq">序号</span><span class="time">时间</span></div><ol class="records" id="log-records"></ol></section><pre class="view json-view hidden" id="runtime"></pre><pre class="view json-view hidden" id="memory-view"></pre><section class="run-panel"><div class="panel-title"><span>AgentRuns</span><span class="run-count" id="run-count">0 / 100</span></div><ol class="run-list" id="run-list"></ol></section></main><div class="drawer-backdrop" id="drawer"><section class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><header><h2 id="drawer-title">事件来源说明</h2><button class="icon-button" id="drawer-close" aria-label="关闭">×</button></header><p>Events 是进程内、有限容量的实时诊断流；Logs 是写入磁盘、可查询的持久记录。因此守护进程事件可能同时出现在两处，但保存周期不同。</p><dl><dt><code>daemon</code> · 守护进程</dt><dd>生命周期、执行状态和其他业务运行记录。</dd><dt><code>adapter-rpc</code> · 适配器 RPC</dt><dd>daemon 与 adapter-host 之间经过凭据脱敏的 RPC 帧。这是 Harness 的边界名称，不是 Provider 原协议名称。</dd><dt><code>provider-native</code> · Provider 原生事件</dt><dd>Codex、Claude Code 等 Provider 自己产生、尚未规范化的事件。</dd><dt><code>adapter-canonical</code> · Adapter 规范化</dt><dd>Adapter 把原生事件转换成 CanonicalEvent 后的结果。</dd><dt><code>host-canonical</code> · Host 校验后</dt><dd>adapter-host 对规范事件完成校验后的输出。</dd><dt><code>runtime</code> · 运行时内部</dt><dd>Agent Work Runtime 的连接、投递与背压状态。</dd><dt><code>worker</code> · Worker 通道</dt><dd>Worker 消息通道上的协议事件。</dd><dt><code>control</code> · 诊断控制</dt><dd>丢帧、序号缺口等 EventBus 自身产生的诊断事件。</dd></dl><p class="drawer-note">典型链路：Provider 原生事件 → Adapter 规范化 → Host 校验后。RPC 帧用于观察这条边界上的请求与响应。</p></section></div><script>
  const sourceLabels=${JSON.stringify(sourceLabels)},MAX_ROWS=1000,DOM_BYTES=2*1024*1024,MAX_RUNS=100,tokenKey='octo-harness.inspect.token:'+location.host,queryToken=new URLSearchParams(location.search).get('token')||'',run=document.querySelector('#run'),source=document.querySelector('#source'),state=document.querySelector('#state'),memory=document.querySelector('#memory'),events=document.querySelector('#event-records'),logs=document.querySelector('#log-records'),runtime=document.querySelector('#runtime'),memoryView=document.querySelector('#memory-view'),auth=document.querySelector('#auth'),authMessage=document.querySelector('#auth-message'),tokenInput=document.querySelector('#token'),runList=document.querySelector('#run-list'),runCount=document.querySelector('#run-count'),drawer=document.querySelector('#drawer');let token=queryToken||sessionStorage.getItem(tokenKey)||'',ws,serverMemory={},domOrder=0;if(queryToken)sessionStorage.setItem(tokenKey,queryToken);tokenInput.value=token;history.replaceState(null,'',location.pathname);
  function textSummary(value){if(value&&typeof value==='object'){for(const key of ['message','text','delta','command','name'])if(typeof value[key]==='string')return value[key].replace(/\\s+/g,' ').slice(0,240)}return JSON.stringify(value).replace(/\\s+/g,' ').slice(0,240)}function clock(value){const date=new Date(value);return Number.isNaN(date.valueOf())?'—':date.toLocaleTimeString([],{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3})}function trimRows(){let count=events.children.length+logs.children.length,bytes=Number(events.dataset.bytes||0)+Number(logs.dataset.bytes||0);while(count>MAX_ROWS||bytes>DOM_BYTES){const first=[events.firstElementChild,logs.firstElementChild].filter(Boolean).sort((a,b)=>Number(a.dataset.order)-Number(b.dataset.order))[0];if(!first)break;const target=first.parentElement,size=Number(first.dataset.bytes||0);target.dataset.bytes=String(Math.max(0,Number(target.dataset.bytes||0)-size));bytes-=size;count-=1;first.remove()}}function row(target,item,durable=false){const sourceName=durable?(item.component||'log'):item.source,name=durable?item.event:item.type,runId=durable?item.run_id:item.agent_run_id,seq=durable?'—':('#'+item.local_seq),time=durable?item.ts:item.occurred_at,payload=durable?item:item.payload,pretty=JSON.stringify(item,null,2),summary=textSummary(payload),li=document.createElement('li');li.className='event';li.dataset.source=sourceName;li.dataset.order=String(++domOrder);li.dataset.bytes=String((pretty.length+summary.length+String(runId||'').length)*2);li.innerHTML='<button class="event-line" type="button"><span class="chevron"></span><span class="source"></span><span class="event-main"><span class="type"></span><span class="summary"></span></span><span class="run-cell"></span><span class="seq"></span><time class="time"></time></button><pre class="detail"></pre>';const cells=li.querySelectorAll('.source,.type,.summary,.run-cell,.seq,.time,.detail');cells[0].textContent=durable?sourceName:(sourceLabels[sourceName]||sourceName);cells[1].textContent=name||'unknown';cells[2].textContent=summary;cells[3].textContent=runId||'—';cells[4].textContent=seq;cells[5].textContent=clock(time);cells[6].textContent=pretty;li.firstElementChild.onclick=()=>li.classList.toggle('open');target.append(li);target.dataset.bytes=String(Number(target.dataset.bytes||0)+Number(li.dataset.bytes));trimRows();const viewport=target.closest('.stream');viewport.scrollTop=viewport.scrollHeight}
  function requireToken(message){state.textContent='token required';state.classList.add('error');authMessage.textContent=message;auth.classList.add('visible');document.body.classList.add('auth-needed')}
  function acceptToken(){state.classList.remove('error');auth.classList.remove('visible');document.body.classList.remove('auth-needed')}
  function renderMemory(){memoryView.textContent=JSON.stringify({...serverMemory,browserDomBudgetBytes:DOM_BYTES,browserDomBytes:Number(events.dataset.bytes||0)+Number(logs.dataset.bytes||0),browserRows:events.children.length+logs.children.length,agentRuns:runList.children.length},null,2)}function trackRun(item){const id=item.agent_run_id;if(!id)return;let li=runList.querySelector('[data-run-id="'+CSS.escape(id)+'"]');if(!li){li=document.createElement('li');li.className='run-item';li.dataset.runId=id;li.innerHTML='<button type="button"><span class="run-id"></span><span class="run-meta"><span class="run-type"></span><time></time></span></button>';li.querySelector('button').onclick=()=>{run.value=id;connect();void loadLogs()}}li.querySelector('.run-id').textContent=id;li.querySelector('.run-type').textContent=item.type;li.querySelector('time').textContent=clock(item.occurred_at);runList.prepend(li);while(runList.children.length>MAX_RUNS)runList.lastElementChild.remove();runCount.textContent=runList.children.length+' / '+MAX_RUNS;renderMemory()}
  function eventMatches(item){const runId=run.value.trim(),selectedSource=source.value,runMatches=!runId||item.agent_run_id===runId||item.type==='bus.gap'||item.type==='bus.correlation_gap',sourceMatches=!selectedSource||item.source===selectedSource||(item.source==='control'&&item.payload?.affected_source===selectedSource);return runMatches&&sourceMatches}function connect(){if(!token){requireToken('Capability token 缺失');return}events.replaceChildren();events.dataset.bytes='0';const q=new URLSearchParams({token});ws?.close();const protocol=location.protocol==='https:'?'wss://':'ws://',current=new WebSocket(protocol+location.host+'/events?'+q);ws=current;let opened=false;current.onopen=()=>{opened=true;state.textContent='实时';acceptToken()};current.onerror=()=>{if(!opened&&ws===current)requireToken('Capability token 缺失或无效')};current.onclose=()=>{if(ws!==current)return;if(!opened)requireToken('Capability token 缺失或无效');else state.textContent='已断开'};current.onmessage=message=>{const body=JSON.parse(message.data);if(body.kind==='status'){serverMemory=body.memory;memory.textContent=Math.round(body.memory.retainedBytes/1024)+' KiB · '+body.memory.retainedEvents+' 条';runtime.textContent=JSON.stringify(body.status,null,2);renderMemory();return}trackRun(body);if(eventMatches(body))row(events,body);renderMemory()}}
  async function loadLogs(){if(!token){requireToken('Capability token 缺失');return}const q=new URLSearchParams();if(run.value.trim())q.set('runId',run.value.trim());const response=await fetch('/api/logs?'+q,{headers:{Authorization:'Bearer '+token}});if(response.status===401){requireToken('Capability token 缺失或无效');return}const body=await response.json();logs.replaceChildren();logs.dataset.bytes='0';for(const item of body)row(logs,item,true)}
  function enteredToken(value){try{const parsed=new URL(value);return parsed.searchParams.get('token')||''}catch{return value.replace(/^\\?token=/,'')}}function openDrawer(){drawer.classList.add('open')}function closeDrawer(){drawer.classList.remove('open')}document.querySelector('#about').onclick=openDrawer;document.querySelector('#source-help').onclick=openDrawer;document.querySelector('#drawer-close').onclick=closeDrawer;drawer.onclick=event=>{if(event.target===drawer)closeDrawer()};document.onkeydown=event=>{if(event.key==='Escape')closeDrawer()};auth.onsubmit=event=>{event.preventDefault();token=enteredToken(tokenInput.value.trim());if(!token){requireToken('请输入 Capability token');return}sessionStorage.setItem(tokenKey,token);tokenInput.value=token;connect()};document.querySelectorAll('nav button').forEach(button=>button.onclick=()=>{document.querySelectorAll('nav button').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.view').forEach(item=>item.classList.add('hidden'));document.querySelector('#'+(button.dataset.view==='memory'?'memory-view':button.dataset.view)).classList.remove('hidden');if(button.dataset.view==='logs')void loadLogs()});run.onchange=()=>{connect();void loadLogs()};source.onchange=connect;connect();
  </script><style>.seq,.time{color:#626c67}.chevron::before{color:#69736e}</style><script>
  let drawerTrigger;
  const drawerCloseButton=document.querySelector('#drawer-close');
  for(const trigger of [document.querySelector('#about'),document.querySelector('#source-help')])trigger.addEventListener('click',()=>{drawerTrigger=trigger;drawerCloseButton.focus()});
  drawerCloseButton.addEventListener('click',()=>drawerTrigger?.focus());
  drawer.addEventListener('click',event=>{if(event.target===drawer)queueMicrotask(()=>drawerTrigger?.focus())});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&drawer.classList.contains('open'))queueMicrotask(()=>drawerTrigger?.focus())});
  drawer.addEventListener('keydown',event=>{if(event.key!=='Tab')return;const focusable=[...drawer.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')];if(!focusable.length)return;const first=focusable[0],last=focusable.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}});
  function enhanceEventLine(node){const button=node.matches?.('.event-line')?node:node.querySelector?.('.event-line');if(!button||button.hasAttribute('aria-expanded'))return;button.setAttribute('aria-expanded','false');button.addEventListener('click',()=>button.setAttribute('aria-expanded',String(button.closest('.event').classList.contains('open'))))}
  document.querySelectorAll('.event-line').forEach(enhanceEventLine);
  new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)enhanceEventLine(node)}).observe(document.querySelector('main'),{subtree:true,childList:true});
  </script></body></html>`;
}
