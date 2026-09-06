import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

/** Filters accepted by the Viewer-to-daemon trace proxy. Sensitive streams are
 * excluded unless the caller opts in for that individual request. */
export interface LogViewerQuery {
  runId?: string;
  includeSensitive?: boolean;
  limit?: number;
}

/** Dependencies and bind settings for the ephemeral local Viewer server. */
export interface LogViewerOptions {
  host?: string;
  port?: number;
  initialRunId?: string;
  query: (options: LogViewerQuery) => Promise<unknown>;
}

/** A running Viewer and its capability-bearing URL. */
export interface LogViewerServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Start an ephemeral, loopback-only trace viewer.
 *
 * The random fragment is a bearer capability. URL fragments are not sent in the
 * initial HTTP request, so the page exchanges it for an Authorization header
 * after load and immediately removes it from visible browser history. The server
 * intentionally exposes only a fixed HTML document and a read-only trace proxy.
 */
export async function startLogViewer({
  host = "127.0.0.1",
  port = 0,
  initialRunId,
  query
}: LogViewerOptions): Promise<LogViewerServer> {
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("log viewer only supports loopback hosts");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("log viewer port must be between 0 and 65535");
  const capability = randomUUID();
  const html = viewerHtml(initialRunId);
  const server = createServer((request, response) => {
    // Trace payloads can contain provider input. Prevent browser caches,
    // referrers, MIME sniffing and embedding from creating secondary copies or
    // exposing the viewer to another local page.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'"
    );
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (url.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (url.pathname !== "/api/traces") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${capability}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    // Querying is delegated to the daemon rather than reading files in the web
    // process. This keeps retention, redaction and sensitive-stream policy in one
    // implementation.
    const runId = url.searchParams.get("runId") || undefined;
    const includeSensitive = url.searchParams.get("includeSensitive") === "1";
    const limitValue = Number(url.searchParams.get("limit") ?? "1000");
    void query({
      ...(runId ? { runId } : {}),
      includeSensitive,
      limit: Number.isSafeInteger(limitValue) ? limitValue : 1000
    }).then(records => {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ records }));
    }).catch(error => {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("log viewer failed to resolve its loopback address");
  const urlHost = host === "::1" ? "[::1]" : host;
  const url = `http://${urlHost}:${address.port}/#${capability}`;
  return {
    url,
    server,
    close: () => new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
    })
  };
}

/** Ask the platform to open the Viewer without keeping a child process handle. */
export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

function viewerHtml(initialRunId?: string): string {
  // Escape '<' even inside JSON so a caller-controlled Run id cannot terminate
  // the inline script and inject markup.
  const initial = JSON.stringify(initialRunId ?? "").replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Octo Harness Trace Viewer</title>
  <style>
    :root { color-scheme: light; --bg:#f4f6f5; --surface:#fff; --line:#d5ddda; --ink:#17211e; --muted:#63706c; --good:#19744d; --warn:#a66b00; --bad:#bd3b2b; --info:#2f6f9f; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input { font:inherit; }
    button { border:1px solid var(--line); background:var(--surface); color:var(--ink); min-height:34px; padding:0 12px; cursor:pointer; }
    button:hover { border-color:#8fa09a; }
    header { height:58px; display:flex; align-items:center; gap:18px; padding:0 18px; border-bottom:1px solid var(--line); background:var(--surface); position:sticky; top:0; z-index:5; }
    header strong { font-size:15px; }
    .status { color:var(--good); font-size:12px; }
    .filters { margin-left:auto; display:flex; align-items:center; gap:8px; }
    .filters input[type="text"] { width:220px; height:34px; border:1px solid var(--line); padding:0 10px; }
    .filters label { display:flex; align-items:center; gap:6px; color:var(--muted); white-space:nowrap; }
    main { display:grid; grid-template-columns:250px minmax(0,1fr) 330px; min-height:calc(100vh - 58px); }
    aside,.detail { background:var(--surface); }
    aside { border-right:1px solid var(--line); }
    .detail { border-left:1px solid var(--line); padding:18px; overflow:auto; }
    .pane-title { margin:0; padding:14px 16px 10px; color:var(--muted); font-size:11px; text-transform:uppercase; }
    #runs { list-style:none; padding:0; margin:0; }
    #runs button { width:100%; border:0; border-top:1px solid var(--line); text-align:left; padding:11px 16px; min-height:58px; }
    #runs button.current { background:#e8efec; box-shadow:inset 3px 0 var(--good); }
    #runs small { display:block; color:var(--muted); margin-top:3px; }
    .workspace { padding:20px; min-width:0; }
    .summary { display:flex; flex-wrap:wrap; gap:18px; padding-bottom:16px; border-bottom:1px solid var(--line); }
    .summary div { min-width:130px; }
    .summary span { display:block; color:var(--muted); font-size:11px; text-transform:uppercase; }
    .summary strong { display:block; margin-top:4px; overflow-wrap:anywhere; }
    #timeline { margin-top:18px; position:relative; }
    #timeline::before { content:""; position:absolute; left:13px; top:12px; bottom:12px; width:1px; background:var(--line); }
    .event { position:relative; display:grid; grid-template-columns:28px 104px minmax(150px,1fr) minmax(120px,.65fr); gap:10px; align-items:start; width:100%; border:0; border-bottom:1px solid var(--line); background:transparent; text-align:left; padding:10px 8px 10px 0; }
    .event:hover,.event.current { background:#fff; }
    .dot { width:9px; height:9px; margin:5px 0 0 9px; border-radius:50%; background:var(--info); position:relative; z-index:1; }
    .event.error .dot { background:var(--bad); }
    .event.success .dot { background:var(--good); }
    .time,.identity { color:var(--muted); font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; overflow-wrap:anywhere; }
    .name { font-weight:650; overflow-wrap:anywhere; }
    .message { display:block; color:var(--muted); font-size:12px; margin-top:2px; }
    .empty { color:var(--muted); padding:38px 10px; text-align:center; }
    pre { margin:12px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .sensitive { color:var(--bad); }
    @media (max-width: 900px) { main { grid-template-columns:190px minmax(0,1fr); } .detail { display:none; } }
    @media (max-width: 640px) { header { height:auto; min-height:58px; flex-wrap:wrap; padding:10px 12px; gap:8px; } .filters { width:100%; margin-left:0; } .filters input[type="text"] { flex:1; width:auto; min-width:0; } main { display:block; } aside { border-right:0; border-bottom:1px solid var(--line); max-height:180px; overflow:auto; } .workspace { padding:14px 12px; } .event { grid-template-columns:28px minmax(0,1fr); gap:3px 10px; } .event .dot { grid-column:1; grid-row:1; } .event .time { grid-column:2; grid-row:1; } .event-content { grid-column:2; grid-row:2; } .identity { grid-column:2; grid-row:3; } }
  </style>
</head>
<body>
  <header>
    <strong>Octo Harness Trace Viewer</strong>
    <span id="connection" class="status">Connecting</span>
    <div class="filters">
      <input id="run-filter" type="text" placeholder="Run ID" aria-label="Run ID">
      <label><input id="sensitive" type="checkbox">敏感 trace</label>
      <button id="refresh" type="button">刷新</button>
    </div>
  </header>
  <main>
    <aside><h2 class="pane-title">Recent runs</h2><ul id="runs"></ul></aside>
    <section class="workspace">
      <div id="summary" class="summary"></div>
      <div id="timeline"></div>
    </section>
    <section class="detail"><h2 class="pane-title">Event evidence</h2><pre id="detail">选择一条事件查看证据。</pre></section>
  </main>
  <script>
    (() => {
      // The fragment never reaches the HTTP server or referrer. Consume it once,
      // then remove it so subsequent navigation and screenshots omit the secret.
      const token = location.hash.slice(1);
      history.replaceState(null, "", location.pathname);
      const initialRun = ${initial};
      const state = { records: [], runId: initialRun, selected: null, sensitive: false };
      const el = id => document.getElementById(id);
      el("run-filter").value = initialRun;

      const text = value => value == null || value === "" ? "-" : String(value);
      const data = record => record && typeof record.data === "object" && record.data ? record.data : {};
      const runId = record => record.run_id || data(record).run_id || "unscoped";
      const identity = record => [record.adapter_type, record.invocation_id, data(record).connection_id, data(record).provider_session_id].filter(Boolean).join(" / ");
      const outcomeClass = record => /failed|error/.test(record.event) || record.level === "error" ? "error" : /ready|completed|written|acknowledged|first|opened/.test(record.event) ? "success" : "";
      const labels = {
        "daemon.starting": "Daemon 正在启动",
        "daemon.ready": "Daemon 已就绪",
        "transport.connection.connecting": "WSS 正在连接",
        "transport.connection.opened": "连接已建立",
        "transport.connection.closed": "连接已关闭",
        "transport.connection.failed": "连接失败",
        "transport.message.received": "WSS 收到消息",
        "transport.message.sent": "WSS 发出消息",
        "chat_turn.received": "收到 ChatTurn",
        "chat_turn.dispatch.accepted": "ChatTurn 已受理",
        "agent_work.command.received": "收到 Agent Work 命令",
        "adapter.selected": "已选择 Adapter",
        "adapter.invoke.started": "Adapter 开始执行",
        "adapter.invoke.completed": "Adapter 执行完成",
        "adapter.invoke.failed": "Adapter 执行失败",
        "provider.input": "模型输入已准备",
        "provider.dispatch.written": "输入已写给 Provider",
        "provider.dispatch.acknowledged": "Provider 已确认",
        "provider.output.first": "Provider 开始输出",
        "provider.dispatch.failed": "Provider 投递失败",
        "capture.receipt": "模型输入证据已落盘",
        "run.execution.started": "Run 开始执行",
        "run.execution.completed": "Run 执行完成",
        "run.execution.failed": "Run 执行失败",
        "rpc.frame": "Adapter RPC 帧"
      };
      const eventLabel = record => {
        if (record.event === "adapter.selected" && record.adapter_type) return "已选择 " + record.adapter_type + " Adapter";
        if (record.event === "transport.connection.opened" && record.scope === "transport.wss") return "WSS 已连接";
        if (record.event === "transport.connection.closed" && record.scope === "transport.wss") return "WSS 已断开";
        if (record.event === "transport.message.received" && data(record).frame_type) return "WSS 收到 " + data(record).frame_type;
        if (record.event === "transport.message.sent" && data(record).frame_type) return "WSS 发出 " + data(record).frame_type;
        return labels[record.event] || record.message || record.event;
      };

      function render() {
        const grouped = new Map();
        for (const record of state.records) {
          const id = runId(record);
          if (!grouped.has(id)) grouped.set(id, []);
          grouped.get(id).push(record);
        }
        const runs = [...grouped.entries()].sort((a,b) => {
          if (a[0] === "unscoped") return 1;
          if (b[0] === "unscoped") return -1;
          return text(b[1].at(-1)?.ts).localeCompare(text(a[1].at(-1)?.ts));
        });
        if (!state.runId && runs.length) state.runId = runs.find(([id]) => id !== "unscoped")?.[0] || runs[0][0];
        el("runs").replaceChildren(...runs.map(([id, records]) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = id === state.runId ? "current" : "";
          const title = document.createElement("strong"); title.textContent = id;
          const meta = document.createElement("small");
          meta.textContent = text(records.at(-1)?.adapter_type || data(records.at(-1)).method || records.at(-1)?.event);
          button.append(title, meta);
          button.onclick = () => { state.runId = id; el("run-filter").value = id === "unscoped" ? "" : id; render(); };
          const item = document.createElement("li");
          item.append(button);
          return item;
        }).filter(Boolean));
        const records = grouped.get(state.runId) || [];
        const first = records[0] || {};
        const last = records.at(-1) || {};
        const adapters = [...new Set(records.map(record => record.adapter_type).filter(Boolean))].join(", ");
        const connection = records.map(record => data(record).connection_id).find(Boolean);
        const chatTurn = records.map(record => data(record).chat_turn_id).find(Boolean);
        el("summary").innerHTML = "";
        for (const [label, value] of [["Run", state.runId], ["Adapter", adapters], ["ChatTurn", chatTurn], ["Connection", connection], ["Events", records.length], ["Last", last.event]]) {
          const item = document.createElement("div");
          const caption = document.createElement("span"); caption.textContent = label;
          const strong = document.createElement("strong"); strong.textContent = text(value);
          item.append(caption, strong); el("summary").append(item);
        }
        el("timeline").replaceChildren(...records.map(record => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "event " + outcomeClass(record) + (state.selected === record ? " current" : "");
          const dot = document.createElement("span"); dot.className = "dot";
          const time = document.createElement("span"); time.className = "time"; time.textContent = text(record.ts).slice(11,23);
          const content = document.createElement("span"); content.className = "event-content";
          const name = document.createElement("span"); name.className = "name"; name.textContent = eventLabel(record);
          const message = document.createElement("span"); message.className = "message"; message.textContent = text(record.event);
          content.append(name, message);
          const ids = document.createElement("span"); ids.className = "identity"; ids.textContent = identity(record) || text(record.component);
          button.append(dot, time, content, ids);
          button.onclick = () => { state.selected = record; el("detail").textContent = JSON.stringify(record, null, 2); render(); };
          return button;
        }));
        if (!records.length) {
          const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "没有匹配的 Run 证据。"; el("timeline").append(empty);
        }
        if (!state.selected && first.event) el("detail").textContent = JSON.stringify(first, null, 2);
      }

      async function refresh() {
        const params = new URLSearchParams({ limit: "1000" });
        const filter = el("run-filter").value.trim();
        if (filter) params.set("runId", filter);
        if (state.sensitive) params.set("includeSensitive", "1");
        try {
          const response = await fetch("/api/traces?" + params.toString(), { headers: { Authorization: "Bearer " + token } });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
          // A trace query may be present in older files or mixed-version daemon
          // output. Filter it defensively to prevent polling from dominating the
          // operator-facing timeline.
          state.records = Array.isArray(body.records)
            ? body.records.filter(record => data(record).method !== "logs.query")
            : [];
          if (filter) state.runId = filter;
          el("connection").textContent = state.sensitive ? "Connected / sensitive" : "Connected";
          el("connection").className = state.sensitive ? "status sensitive" : "status";
          render();
        } catch (error) {
          el("connection").textContent = "Error: " + error.message;
          el("connection").className = "status sensitive";
        }
      }

      el("refresh").onclick = refresh;
      el("run-filter").onchange = refresh;
      el("sensitive").onchange = event => {
        // Provider input can contain customer data and credentials that survived
        // structural redaction. Require a deliberate action before requesting it.
        if (event.target.checked && !confirm("敏感 trace 可能包含完整模型输入。仅在受控本机环境中展开。")) event.target.checked = false;
        state.sensitive = event.target.checked;
        refresh();
      };
      let sensitiveTimer;
      const armSensitiveTimeout = () => {
        if (!state.sensitive) return;
        clearTimeout(sensitiveTimer);
        sensitiveTimer = setTimeout(() => {
          // Sensitive access is a short-lived viewing state, not a preference.
          state.sensitive = false;
          el("sensitive").checked = false;
          refresh();
        }, 10 * 60 * 1000);
      };
      for (const event of ["pointerdown", "keydown"]) window.addEventListener(event, armSensitiveTimeout, { passive: true });
      el("sensitive").addEventListener("change", armSensitiveTimeout);
      refresh();
      setInterval(refresh, 2000);
    })();
  </script>
</body>
</html>`;
}
