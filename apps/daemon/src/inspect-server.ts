import { randomInt, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { LIVE_EVENT_SOURCES, type LiveEventBus, type LiveEventSource } from "./live-event-bus.js";

const HOST = "127.0.0.1";
const MIN_PORT = 20_000;
const MAX_ATTEMPTS = 32;

export class InspectServer {
  readonly #events: LiveEventBus;
  readonly #status: () => unknown;
  readonly #logs: (runId?: string) => Promise<unknown>;
  #server?: Server;
  #websocket?: WebSocketServer;
  #url?: string;
  #opening?: Promise<string>;

  constructor(events: LiveEventBus, status: () => unknown, logs: (runId?: string) => Promise<unknown>) {
    this.#events = events;
    this.#status = status;
    this.#logs = logs;
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
    const websocket = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const server = createServer((request, response) => {
      secureHeaders(response);
      const address = server.address();
      if (!address || typeof address === "string" || request.headers.host !== `${HOST}:${address.port}`) {
        response.writeHead(404).end();
        return;
      }
      const url = new URL(request.url ?? "/", `http://${HOST}:${address.port}`);
      if (request.method === "GET" && url.pathname === "/api/logs") {
        if (request.headers.authorization !== `Bearer ${capability}`) {
          response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        void this.#logs(url.searchParams.get("runId") || undefined).then(logs => {
          response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify(logs));
        }).catch(error => {
          response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
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
      const expectedOrigin = `http://${HOST}:${address.port}`;
      const url = new URL(request.url ?? "/", expectedOrigin);
      if (request.headers.host !== `${HOST}:${address.port}`
        || request.headers.origin !== expectedOrigin
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
      const url = new URL(request.url ?? "/", `http://${HOST}:${address.port}`);
      const runId = url.searchParams.get("runId") || undefined;
      const sourceValue = url.searchParams.get("source") || undefined;
      const source = isSource(sourceValue) ? sourceValue : undefined;
      client.send(JSON.stringify({ kind: "status", status: this.#status(), memory: this.#events.stats }));
      const controller = new AbortController();
      client.once("close", () => controller.abort());
      void (async () => {
        try {
          for await (const event of this.#events.subscribe({ runId, source }, true, controller.signal)) {
            if (client.readyState !== client.OPEN) break;
            await sendWebSocketLine(client, JSON.stringify({ kind: "event", event }));
          }
        } catch (error) {
          if (client.readyState === client.OPEN) client.close(1011, error instanceof Error ? error.message.slice(0, 100) : "stream failed");
        }
      })();
    });
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const port = randomInt(MIN_PORT, 65_536);
      try {
        await listen(server, port);
        this.#server = server;
        this.#websocket = websocket;
        this.#url = `http://${HOST}:${port}/#${capability}`;
        return this.#url;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    websocket.close();
    throw new Error(`inspect could not bind a loopback port after ${MAX_ATTEMPTS} attempts`);
  }

  async close(): Promise<void> {
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

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
    const onListening = (): void => { server.off("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
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

async function sendWebSocketLine(client: WebSocket, value: string): Promise<void> {
  const encoded = Buffer.from(value);
  for (let offset = 0; offset < encoded.byteLength; offset += 16 * 1024) {
    const chunk = encoded.subarray(offset, Math.min(offset + 16 * 1024, encoded.byteLength));
    const fin = offset + chunk.byteLength >= encoded.byteLength;
    await new Promise<void>((resolve, reject) => {
      client.send(chunk, { binary: false, fin }, error => error ? reject(error) : resolve());
    });
  }
}

function inspectHtml(): string {
  const sourceOptions = LIVE_EVENT_SOURCES.map(source => `<option>${source}</option>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Octo Harness Inspect</title><style>
  :root{color-scheme:light;--bg:#f3f5f4;--panel:#e7ece9;--line:#c4cfca;--ink:#18211e;--muted:#596862;--green:#1e7954;--blue:#286ea6;--violet:#7651a8;--amber:#9a6500;--red:#b54135}*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--ink);font:13px/1.45 "Avenir Next","Segoe UI",sans-serif}button,input,select{font:inherit}header{height:54px;display:flex;align-items:center;gap:18px;padding:0 16px;border-bottom:1px solid var(--line);background:#fbfcfb}header strong{font-size:15px;font-weight:700}.state{color:var(--green)}.memory{margin-left:auto;color:var(--muted)}main{display:grid;grid-template-columns:220px minmax(0,1fr);height:calc(100vh - 54px)}aside{grid-column:1;grid-row:1;padding:14px;border-right:1px solid var(--line);background:var(--panel)}nav{display:grid;gap:4px;margin-bottom:18px}nav button{height:34px;text-align:left;border:1px solid transparent;background:transparent;color:var(--muted);cursor:pointer}nav button:hover,nav button:focus-visible{border-color:#91a199;outline:0}nav button.active{border-color:var(--line);background:#fbfcfb;color:var(--ink)}label{display:block;color:var(--muted);margin:0 0 12px}input,select{width:100%;height:34px;margin-top:5px;padding:6px 8px;background:#fbfcfb;color:var(--ink);border:1px solid var(--line)}input:focus-visible,select:focus-visible{outline:2px solid var(--blue);outline-offset:1px}.view{grid-column:2;grid-row:1;height:100%;overflow:auto}.view.hidden{display:none}.records{margin:0;padding:0;list-style:none}.event{display:grid;grid-template-columns:112px 170px minmax(0,1fr);gap:10px;min-height:38px;padding:8px 12px;border-bottom:1px solid #dbe2de}.source{color:var(--blue);font-weight:650}.event[data-source="adapter-rpc"] .source{color:var(--violet)}.event[data-source="provider-native"] .source{color:var(--amber)}.event[data-source="adapter-canonical"] .source{color:#365fb3}.event[data-source="host-canonical"] .source{color:var(--green)}.event[data-source="control"] .source{color:var(--red)}.type{color:#765719;font-weight:650}.payload,pre{font-family:"Berkeley Mono","SFMono-Regular",Consolas,monospace}.payload{white-space:pre-wrap;overflow-wrap:anywhere;color:#36443f}pre{margin:0;padding:18px;white-space:pre-wrap;overflow-wrap:anywhere;color:#36443f}@media(max-width:700px){header{gap:10px}.memory{font-size:11px}main{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}aside{grid-column:1;grid-row:1;padding:10px;border-right:0;border-bottom:1px solid var(--line)}nav{grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:10px}nav button{text-align:center;padding:0 4px}aside label{display:inline-block;width:calc(50% - 4px);margin:0 4px 0 0}.view{grid-column:1;grid-row:2}.event{grid-template-columns:88px 112px minmax(0,1fr);padding:7px 9px}}
  </style></head><body><header><strong>Octo Harness Inspect</strong><span class="state" id="state">connecting</span><span class="memory" id="memory"></span></header><main><aside><nav><button class="active" data-view="events">Events</button><button data-view="logs">Durable logs</button><button data-view="runtime">Runtime</button><button data-view="memory">Memory</button></nav><label>Run ID<input id="run" placeholder="all runs"></label><label>Source<select id="source"><option value="">all sources</option>${sourceOptions}</select></label></aside><ol class="view records" id="events"></ol><ol class="view records hidden" id="logs"></ol><pre class="view hidden" id="runtime"></pre><pre class="view hidden" id="memory-view"></pre></main><script>
  const token=location.hash.slice(1),run=document.querySelector('#run'),source=document.querySelector('#source'),state=document.querySelector('#state'),memory=document.querySelector('#memory'),events=document.querySelector('#events'),logs=document.querySelector('#logs'),runtime=document.querySelector('#runtime'),memoryView=document.querySelector('#memory-view');history.replaceState(null,'',location.pathname);let ws;
  function row(target,left,name,payload){const li=document.createElement('li');li.className='event';li.dataset.source=left;li.innerHTML='<span class="source"></span><span class="type"></span><span class="payload"></span>';li.children[0].textContent=left;li.children[1].textContent=name;li.children[2].textContent=JSON.stringify(payload);target.append(li);while(target.children.length>1000)target.firstChild.remove()}
  function connect(){events.replaceChildren();const q=new URLSearchParams({token});if(run.value.trim())q.set('runId',run.value.trim());if(source.value)q.set('source',source.value);ws?.close();ws=new WebSocket('ws://'+location.host+'/events?'+q);ws.onopen=()=>state.textContent='live';ws.onclose=()=>state.textContent='closed';ws.onmessage=message=>{const body=JSON.parse(message.data);if(body.kind==='status'){memory.textContent=Math.round(body.memory.retainedBytes/1024)+' KiB · '+body.memory.retainedEvents+' events';runtime.textContent=JSON.stringify(body.status,null,2);memoryView.textContent=JSON.stringify(body.memory,null,2);return}row(events,body.event.source,body.event.type,body.event.payload)}}
  async function loadLogs(){const q=new URLSearchParams();if(run.value.trim())q.set('runId',run.value.trim());const response=await fetch('/api/logs?'+q,{headers:{Authorization:'Bearer '+token}});const body=await response.json();logs.replaceChildren();for(const item of body)row(logs,item.component||'log',item.event,item)}
  document.querySelectorAll('nav button').forEach(button=>button.onclick=()=>{document.querySelectorAll('nav button').forEach(item=>item.classList.toggle('active',item===button));document.querySelectorAll('.view').forEach(item=>item.classList.add('hidden'));document.querySelector('#'+(button.dataset.view==='memory'?'memory-view':button.dataset.view)).classList.remove('hidden');if(button.dataset.view==='logs')void loadLogs()});run.onchange=()=>{connect();void loadLogs()};source.onchange=connect;connect();
  </script></body></html>`;
}
