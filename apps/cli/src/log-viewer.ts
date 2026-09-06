import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";

/** Filters accepted by the Viewer-to-daemon trace proxy. Sensitive streams are
 * excluded unless the caller opts in for that individual request. */
export interface LogViewerQuery {
  runId?: string;
  includeSensitive?: boolean;
  limit?: number;
  after?: string;
  fromSeq?: number;
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
    if (request.method !== "GET") {
      response.writeHead(405, { "Content-Type": "application/json", Allow: "GET" });
      response.end(JSON.stringify({ error: "method_not_allowed" }));
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
    const limitValue = Number(url.searchParams.get("limit") ?? "250");
    const after = url.searchParams.get("after") || undefined;
    const fromSeqValue = Number(url.searchParams.get("fromSeq") ?? "1");
    void query({
      ...(runId ? { runId } : {}),
      includeSensitive,
      limit: Number.isSafeInteger(limitValue) && limitValue > 0 ? Math.min(limitValue, 1000) : 250,
      ...(after && after.length <= 2048 ? { after } : {}),
      ...(Number.isSafeInteger(fromSeqValue) && fromSeqValue > 0 ? { fromSeq: fromSeqValue } : { fromSeq: 1 })
    }).then(result => {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      const payload = result !== null && typeof result === "object" && !Array.isArray(result)
        ? result
        : { records: result };
      response.end(JSON.stringify(payload));
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
<html lang="en">
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
    .summary .alert { color:var(--bad); }
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
    .source { display:inline-block; margin-left:6px; color:var(--muted); font-size:10px; font-weight:500; text-transform:uppercase; }
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
      <label><input id="sensitive" type="checkbox">Sensitive trace</label>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <main>
    <aside><h2 class="pane-title">Recent runs</h2><ul id="runs"></ul></aside>
    <section class="workspace">
      <div id="summary" class="summary"></div>
      <div id="timeline"></div>
    </section>
    <section class="detail"><h2 class="pane-title">Event evidence</h2><pre id="detail">Select an event to inspect its evidence.</pre></section>
  </main>
  <script>
    (() => {
      // The fragment never reaches the HTTP server or referrer. Consume it once,
      // then remove it so subsequent navigation and screenshots omit the secret.
      const token = location.hash.slice(1);
      history.replaceState(null, "", location.pathname);
      const initialRun = ${initial};
      const MAX_CLIENT_EVENTS = 2000;
      const state = {
        records: new Map(), canonical: new Map(), runs: [], runId: initialRun,
        selectedKey: null, sensitive: false, cursor: null, nextSeq: 1, refreshing: false
      };
      const el = id => document.getElementById(id);
      el("run-filter").value = initialRun;

      const text = value => value == null || value === "" ? "-" : String(value);
      const data = record => record && typeof record.data === "object" && record.data ? record.data : {};
      const identity = record => [
        record.adapter_type && "adapter " + record.adapter_type,
        record.invocation_id && "invoke " + record.invocation_id,
        data(record).connection_id && "conn " + data(record).connection_id,
        data(record).provider_session_id && "provider session " + data(record).provider_session_id,
        data(record).provider_request_id && "request " + data(record).provider_request_id,
        data(record).capture_id && "capture " + data(record).capture_id
      ].filter(Boolean).join(" / ");
      const outcomeClass = record => /failed|error/.test(record.event) || record.level === "error" ? "error" : /ready|completed|finished|written|acknowledged|first|opened/.test(record.event) ? "success" : "";
      const labels = {
        "daemon.starting": "Daemon starting", "daemon.ready": "Daemon ready",
        "transport.connection.connecting": "WSS connecting", "transport.connection.opened": "Connection opened",
        "transport.connection.closed": "Connection closed", "transport.connection.failed": "Connection failed",
        "transport.message.received": "WSS message received", "transport.message.sent": "WSS message sent",
        "chat_turn.received": "ChatTurn received", "chat_turn.dispatch.accepted": "ChatTurn accepted",
        "agent_work.command.received": "Agent Work command received", "adapter.selected": "Adapter selected",
        "adapter.invoke.started": "Adapter invocation started", "adapter.invoke.completed": "Adapter invocation completed",
        "adapter.invoke.failed": "Adapter invocation failed", "provider.input": "Provider input prepared",
        "provider.dispatch.written": "Input written to provider", "provider.dispatch.acknowledged": "Provider acknowledged input",
        "provider.output.first": "Provider output started", "provider.dispatch.failed": "Provider dispatch failed",
        "provider.output": "Provider output captured", "capture.receipt": "Provider evidence persisted",
        "run.queued": "Run queued", "run.running": "Run running",
        "run.finished": "Run completed", "run.error": "Run failed", "run.stopped": "Run cancelled",
        "run.execution.started": "Run execution started", "run.execution.completed": "Run execution completed",
        "run.execution.failed": "Run execution failed", "rpc.frame": "Adapter RPC frame"
      };
      const eventLabel = record => {
        if (record.event === "adapter.selected" && record.adapter_type) return record.adapter_type + " adapter selected";
        if (record.event === "transport.connection.opened" && record.scope === "transport.wss") return "WSS connected";
        if (record.event === "transport.connection.closed" && record.scope === "transport.wss") return "WSS disconnected";
        if (record.event === "transport.message.received" && data(record).frame_type) return "WSS received " + data(record).frame_type;
        if (record.event === "transport.message.sent" && data(record).frame_type) return "WSS sent " + data(record).frame_type;
        if (record.event === "capture.receipt" && data(record).state === "failed") return "Provider evidence capture failed";
        return labels[record.event] || record.message || record.event;
      };

      const duration = value => {
        if (!Number.isFinite(value)) return "-";
        if (value < 1000) return Math.round(value) + " ms";
        if (value < 60000) return (value / 1000).toFixed(1) + " s";
        return (value / 60000).toFixed(1) + " min";
      };
      const recordKey = record => record.source === "state"
        ? "state:" + text(record.id)
        : "log:" + [record.process_instance_id, record.seq, record.ts, record.event].map(text).join(":");
      function resetWindow(nextRunId) {
        state.runId = nextRunId;
        state.records.clear(); state.canonical.clear();
        state.selectedKey = null; state.cursor = null; state.nextSeq = 1;
        el("detail").textContent = "Select an event to inspect its evidence.";
      }
      function mergeBounded(target, incoming) {
        for (const record of incoming) target.set(recordKey(record), record);
        const ordered = [...target.entries()].sort((left, right) => text(left[1].ts).localeCompare(text(right[1].ts)));
        for (const [key] of ordered.slice(0, Math.max(0, ordered.length - MAX_CLIENT_EVENTS))) target.delete(key);
      }

      function render() {
        const selectedRun = state.runs.find(run => run.runId === state.runId);
        el("runs").replaceChildren(...state.runs.map(run => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = run.runId === state.runId ? "current" : "";
          const title = document.createElement("strong"); title.textContent = run.runId;
          const meta = document.createElement("small");
          meta.textContent = [text(run.status), text(run.adapterType), duration(run.durationMs)].join(" / ");
          button.append(title, meta);
          button.onclick = () => {
            resetWindow(run.runId); el("run-filter").value = run.runId; render(); void refresh();
          };
          const item = document.createElement("li");
          item.append(button);
          return item;
        }));
        // The daemon already returns only the selected Run plus records joined by
        // explicit connection/chatTurn identity. Filtering by run_id here would
        // hide the pre-Run WSS handshake that operators need for reconstruction.
        const records = [...state.records.values(), ...state.canonical.values()]
          .sort((left, right) => text(left.ts).localeCompare(text(right.ts)))
          .slice(-MAX_CLIENT_EVENTS);
        const first = records[0] || {};
        el("summary").innerHTML = "";
        const conversation = selectedRun?.conversation || {};
        const summaryItems = [
          ["Run", selectedRun?.runId || state.runId], ["Status", selectedRun?.status],
          ["Duration", duration(selectedRun?.durationMs)],
          ["Stall", selectedRun?.stalled ? duration(selectedRun.stallMs) + " without an event" : "No"],
          ["Session", selectedRun?.sessionId],
          ["Conversation", conversation.title || conversation.channel || conversation.id],
          ["ChatTurn", selectedRun?.chatTurnId], ["Invocation", selectedRun?.invocationId],
          ["Adapter", selectedRun?.adapterType], ["Model", selectedRun?.model],
          ["Provider session", selectedRun?.providerSessionId], ["Started", selectedRun?.startedAt],
          ["Ended", selectedRun?.endedAt], ["Canonical events", selectedRun?.eventCount]
        ];
        for (const [label, value] of summaryItems) {
          const item = document.createElement("div");
          const caption = document.createElement("span"); caption.textContent = label;
          const strong = document.createElement("strong");
          strong.textContent = text(value);
          if (label === "Stall" && selectedRun?.stalled) strong.className = "alert";
          item.append(caption, strong); el("summary").append(item);
        }
        el("timeline").replaceChildren(...records.map(record => {
          const key = recordKey(record);
          const button = document.createElement("button");
          button.type = "button";
          button.className = "event " + outcomeClass(record) + (state.selectedKey === key ? " current" : "");
          const dot = document.createElement("span"); dot.className = "dot";
          const time = document.createElement("span"); time.className = "time"; time.textContent = text(record.ts).slice(11,23);
          const content = document.createElement("span"); content.className = "event-content";
          const name = document.createElement("span"); name.className = "name"; name.textContent = eventLabel(record);
          const message = document.createElement("span"); message.className = "message"; message.textContent = text(record.event);
          if (record.source === "state") {
            const source = document.createElement("span"); source.className = "source"; source.textContent = "state.db";
            name.append(source);
          }
          content.append(name, message);
          const ids = document.createElement("span"); ids.className = "identity"; ids.textContent = identity(record) || text(record.component);
          button.append(dot, time, content, ids);
          button.onclick = () => { state.selectedKey = key; el("detail").textContent = JSON.stringify(record, null, 2); render(); };
          return button;
        }));
        if (!records.length) {
          const empty = document.createElement("div"); empty.className = "empty"; empty.textContent = "No evidence matches this Run."; el("timeline").append(empty);
        }
        if (!state.selectedKey && first.event) el("detail").textContent = JSON.stringify(first, null, 2);
      }

      async function refresh() {
        if (state.refreshing) return;
        state.refreshing = true;
        const params = new URLSearchParams({ limit: "250", fromSeq: String(state.nextSeq) });
        if (state.runId) params.set("runId", state.runId);
        if (state.cursor) params.set("after", state.cursor);
        if (state.sensitive) params.set("includeSensitive", "1");
        try {
          const response = await fetch("/api/traces?" + params.toString(), { headers: { Authorization: "Bearer " + token } });
          const body = await response.json();
          if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
          state.runs = Array.isArray(body.runs) ? body.runs.slice(0, 101) : state.runs;
          if (!state.runId && body.selectedRunId) {
            state.runId = body.selectedRunId;
            el("run-filter").value = state.runId;
          }
          const incomingRecords = Array.isArray(body.records)
            ? body.records.filter(record => data(record).method !== "logs.query" && data(record).method !== "logs.viewer")
            : [];
          if (body.reset) {
            state.records.clear();
            state.selectedKey = null;
            el("detail").textContent = "Select an event to inspect its evidence.";
          }
          mergeBounded(state.records, incomingRecords);
          mergeBounded(state.canonical, Array.isArray(body.events) ? body.events : []);
          if (typeof body.cursor === "string") state.cursor = body.cursor;
          if (Number.isSafeInteger(body.nextSeq) && body.nextSeq > 0) state.nextSeq = body.nextSeq;
          el("connection").textContent = state.sensitive ? "Connected / sensitive" : "Connected";
          el("connection").className = state.sensitive ? "status sensitive" : "status";
          render();
          if (body.hasMore) setTimeout(refresh, 0);
        } catch (error) {
          el("connection").textContent = "Error: " + error.message;
          el("connection").className = "status sensitive";
        } finally {
          state.refreshing = false;
        }
      }

      el("refresh").onclick = refresh;
      el("run-filter").onchange = event => {
        resetWindow(event.target.value.trim());
        void refresh();
      };
      el("sensitive").onchange = event => {
        // Provider input can contain customer data and credentials that survived
        // structural redaction. Require a deliberate action before requesting it.
        if (event.target.checked && !confirm("Sensitive trace may contain complete provider input. Reveal it only in a controlled local environment.")) event.target.checked = false;
        state.sensitive = event.target.checked;
        resetWindow(state.runId);
        void refresh();
      };
      let sensitiveTimer;
      const armSensitiveTimeout = () => {
        if (!state.sensitive) return;
        clearTimeout(sensitiveTimer);
        sensitiveTimer = setTimeout(() => {
          // Sensitive access is a short-lived viewing state, not a preference.
          state.sensitive = false;
          el("sensitive").checked = false;
          resetWindow(state.runId);
          void refresh();
        }, 10 * 60 * 1000);
      };
      for (const event of ["pointerdown", "keydown"]) window.addEventListener(event, armSensitiveTimeout, { passive: true });
      el("sensitive").addEventListener("change", armSensitiveTimeout);
      void refresh();
      setInterval(() => void refresh(), 2000);
    })();
  </script>
</body>
</html>`;
}
