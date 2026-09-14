import {
  Activity,
  AlertCircle,
  CircleHelp,
  Cpu,
  Database,
  FileArchive,
  FileText,
  KeyRound,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Server,
  TerminalSquare,
  X
} from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EventStream, type ColumnFilters } from "./components/event-stream";
import { QueryInput } from "./components/query-input";
import { Button } from "./components/ui/button";
import { Tooltip, TooltipProvider } from "./components/ui/tooltip";
import type { InspectRecord } from "./domain";
import { downloadInspectBundle } from "./export";
import { cn } from "./lib/utils";
import { InspectStore } from "./store/inspect-store";
import {
  initialCapabilityToken,
  InspectTransport,
  saveCapabilityToken,
  tokenFromInput
} from "./transport/inspect-websocket";

type ViewName = "events" | "logs" | "runtime" | "memory";

const VIEWS: Array<{ name: ViewName; label: string; icon: typeof Activity }> = [
  { name: "events", label: "实时事件", icon: Activity },
  { name: "logs", label: "持久日志", icon: FileText },
  { name: "runtime", label: "运行时", icon: Cpu },
  { name: "memory", label: "内存", icon: Database }
];

const EMPTY_COLUMN_FILTERS: ColumnFilters = { stage: "", direction: "", adapter: "" };

export function App() {
  const store = useMemo(() => new InspectStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const transport = useMemo(() => new InspectTransport({
    onConnection: (state, message) => store.setConnection(state, message),
    onStatus: (status, memory) => store.setStatus(status, memory),
    onEvents: events => store.appendEvents(events)
  }), [store]);
  const [token, setToken] = useState(initialCapabilityToken);
  const [tokenInput, setTokenInput] = useState(token);
  const [view, setView] = useState<ViewName>("events");
  const [lockTop, setLockTop] = useState(true);
  const [onlyErrors, setOnlyErrors] = useState(false);
  const [columnFilters, setColumnFilters] = useState<ColumnFilters>(EMPTY_COLUMN_FILTERS);
  const [helpOpen, setHelpOpen] = useState(() => location.pathname === "/help");
  const [logsState, setLogsState] = useState<"idle" | "loading" | "loaded" | "error">("idle");

  useEffect(() => {
    transport.start(token);
    return () => transport.stop();
  }, [token, transport]);

  const loadLogs = (): void => {
    setLogsState("loading");
    void transport.loadLogs().then(logs => {
      store.setLogs(logs);
      setLogsState("loaded");
    }).catch(error => {
      if ((error as Error).name !== "AbortError") setLogsState("error");
    });
  };

  const selectView = (next: ViewName): void => {
    setView(next);
    if (next === "logs" && logsState === "idle") loadLogs();
  };

  const submitToken = (event: FormEvent): void => {
    event.preventDefault();
    const parsed = tokenFromInput(tokenInput.trim());
    if (!parsed) return;
    transport.stop();
    saveCapabilityToken(parsed);
    store.clearEvents();
    store.setLogs([]);
    setLogsState("idle");
    setView("events");
    setTokenInput(parsed);
    setToken(parsed);
  };

  const resetFilters = (): void => {
    store.setQuery("");
    setOnlyErrors(false);
    setColumnFilters(EMPTY_COLUMN_FILTERS);
  };

  const sourceRecords = view === "logs" ? snapshot.filteredLogs : snapshot.filteredEvents;
  const visibleRecords = filterRecords(sourceRecords, onlyErrors, columnFilters);
  const errorCount = snapshot.events.filter(record => record.status === "error").length;
  const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/events`;
  const serverBytes = typeof snapshot.serverMemory.retainedBytes === "number" ? snapshot.serverMemory.retainedBytes : 0;

  const exportBundle = (): void => downloadInspectBundle(snapshot.events, {
    event_count: snapshot.events.length,
    error_count: errorCount,
    browser_retained_bytes: snapshot.retainedBytes,
    server_memory: snapshot.serverMemory,
    runtime_status: snapshot.status
  });

  return (
    <TooltipProvider>
      <div className="inspect-shell">
        <header className="topbar">
          <div className="brand-block">
            <span className="brand-icon"><TerminalSquare aria-hidden="true" /></span>
            <strong>Octo Harness Inspect</strong>
            <span className="brand-slash">/</span>
            <span className="brand-subtitle">实时事件调试台</span>
            <span className="topbar-divider" />
            <ConnectionState state={snapshot.connection} message={snapshot.connectionMessage} url={wsUrl} />
          </div>

          <div className="topbar-actions">
            <div className="topbar-counts">
              <span className="error-count"><AlertCircle />{errorCount.toLocaleString()} 异常</span>
              <i />
              <span><em>已缓存:</em> <b>{snapshot.events.length.toLocaleString()} 条</b></span>
            </div>
            <div className="stream-control">
              <button type="button" aria-pressed={!lockTop} onClick={() => setLockTop(value => !value)}>
                <span className={cn("stream-dot", snapshot.connection === "live" && "stream-dot--live")} />
                {lockTop ? <Pause /> : <Play />}
                <span>{lockTop ? "暂停置顶" : "恢复置顶"}</span>
              </button>
              <span title="达到队列上限时淘汰最旧事件">上限 6,000 条 (自动环形淘汰)</span>
            </div>
            {snapshot.connection === "disconnected" && (
              <Tooltip label="立即重新连接">
                <button type="button" className="icon-action" aria-label="立即重新连接" onClick={() => transport.retry()}><RefreshCw /></button>
              </Tooltip>
            )}
            <Tooltip label="导出当前内存缓冲为 ZIP">
              <button type="button" className="zip-action" onClick={exportBundle}><FileArchive />导出 ZIP</button>
            </Tooltip>
            <button type="button" className="help-action" onClick={() => setHelpOpen(true)}><CircleHelp />帮助文档</button>
          </div>
        </header>

        {snapshot.connection === "auth-required" && (
          <form className="auth-bar" onSubmit={submitToken}>
            <KeyRound aria-hidden="true" />
            <span>{snapshot.connectionMessage}</span>
            <input
              type="password"
              aria-label="Capability token"
              autoComplete="off"
              spellCheck={false}
              value={tokenInput}
              onChange={event => setTokenInput(event.target.value)}
              placeholder="粘贴 token 或完整 Inspect URL"
            />
            <Button type="submit">连接</Button>
          </form>
        )}

        <section className="filter-bar">
          <div className="filter-row">
            <div className="view-tabs" role="tablist" aria-label="Inspect 数据视图">
              {VIEWS.map(item => (
                <button
                  key={item.name}
                  type="button"
                  role="tab"
                  aria-selected={view === item.name}
                  onClick={() => selectView(item.name)}
                >
                  <item.icon />{item.label}
                </button>
              ))}
            </div>
            {(view === "events" || view === "logs") && (
              <div className="query-wrap">
                <QueryInput
                  value={snapshot.query}
                  error={snapshot.queryError}
                  values={store.valueOptions()}
                  onChange={query => store.setQuery(query)}
                />
              </div>
            )}
            <div className="quick-filters">
              <button type="button" className={!onlyErrors ? "quick-filter--active" : ""} onClick={() => setOnlyErrors(false)}>
                <i className="all-dot" />全部 ({sourceRecords.length.toLocaleString()})
              </button>
              <button type="button" className={cn("quick-filter--error", onlyErrors && "quick-filter--selected")} onClick={() => setOnlyErrors(true)}>
                <i />仅看异常 ({sourceRecords.filter(record => record.status === "error").length.toLocaleString()})
              </button>
              <button type="button" className="reset-action" onClick={resetFilters}><RotateCcw />重置</button>
            </div>
          </div>
        </section>

        <main className="workspace">
          {view === "events" && (
            <EventStream
              records={visibleRecords}
              allRecords={sourceRecords}
              lockTop={lockTop}
              live={snapshot.connection === "live"}
              filters={columnFilters}
              onFiltersChange={setColumnFilters}
              onQuickFilter={(field, value) => store.setQuery(`${field}="${value.replaceAll('"', '\\"')}"`)}
            />
          )}
          {view === "logs" && logsState === "loading" && <Centered>正在读取持久日志...</Centered>}
          {view === "logs" && logsState === "error" && (
            <Centered><div className="inline-message"><span>持久日志读取失败</span><Button onClick={loadLogs}><RefreshCw />重试</Button></div></Centered>
          )}
          {view === "logs" && (logsState === "loaded" || logsState === "idle") && (
            <EventStream
              records={visibleRecords}
              allRecords={sourceRecords}
              lockTop={false}
              live={false}
              filters={columnFilters}
              onFiltersChange={setColumnFilters}
              onQuickFilter={(field, value) => store.setQuery(`${field}="${value.replaceAll('"', '\\"')}"`)}
            />
          )}
          {view === "runtime" && <JsonView title="运行时状态" value={snapshot.status} />}
          {view === "memory" && <JsonView title="内存状态" value={{
            ...snapshot.serverMemory,
            browserEventBytes: snapshot.retainedBytes,
            browserEvents: snapshot.events.length,
            browserVisibleEvents: snapshot.filteredEvents.length,
            agentRuns: snapshot.runs.length
          }} />}
        </main>

        <footer className="statusbar">
          <div>
            <span>显示 <b>{visibleRecords.length.toLocaleString()}</b> / {sourceRecords.length.toLocaleString()} 条</span>
            <i />
            <span>浏览器缓冲 <b>{formatBytes(snapshot.retainedBytes)}</b></span>
            <i />
            <span>Daemon 缓冲 <b>{formatBytes(serverBytes)}</b></span>
          </div>
          <div>
            <span>顶部追加 (Prepend)</span>
            <i />
            <strong className={cn(snapshot.connection === "live" && "statusbar--live")}>全双工实时监听 · {snapshot.connection === "live" ? "接收中 (LIVE)" : snapshot.connectionMessage}</strong>
          </div>
        </footer>
      </div>

      {helpOpen && <HelpDialog onClose={() => {
        setHelpOpen(false);
        if (location.pathname === "/help") history.replaceState(null, "", "/");
      }} />}
    </TooltipProvider>
  );
}

function filterRecords(records: readonly InspectRecord[], onlyErrors: boolean, filters: ColumnFilters): InspectRecord[] {
  return records.filter(record => {
    if (onlyErrors && record.status !== "error") return false;
    if (filters.stage && record.stage !== filters.stage) return false;
    if (filters.direction && record.direction !== filters.direction) return false;
    if (filters.adapter && record.adapterType !== filters.adapter) return false;
    return true;
  });
}

function ConnectionState({ state, message, url }: { state: string; message: string; url: string }) {
  return (
    <span className={cn("connection-badge", `connection-badge--${state}`)} title={message}>
      <i />
      <b>{state === "live" ? "WS 已连接" : state === "connecting" ? "WS 连接中" : "WS 已断开"}</b>
      <em>·</em>
      <span>{url}</span>
    </span>
  );
}

function JsonView({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="json-view">
      <header><strong>{title}</strong><span>来自当前 daemon 的实时诊断快照</span></header>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="centered-state">{children}</div>;
}

function HelpDialog({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.currentTarget === event.target) onClose();
    }}>
      <section role="dialog" aria-modal="true" aria-labelledby="help-title" className="help-dialog">
        <header>
          <Server />
          <h2 id="help-title">Inspect 数据链路</h2>
          <button type="button" autoFocus aria-label="关闭" onClick={onClose}><X /></button>
        </header>
        <div>
          <p>Events 是 daemon 内存中的实时有界诊断流；Logs 是写入磁盘的持久运行记录，两者都不是 AgentRun 的完整业务轨迹。</p>
          <code>provider-native → adapter-canonical → host-canonical</code>
          <dl>
            <dt>adapter-rpc</dt><dd>daemon 与 adapter-host 之间经过凭据脱敏的 RPC 帧。</dd>
            <dt>provider-native</dt><dd>Provider 产生、尚未规范化的原生事件。</dd>
            <dt>adapter-canonical</dt><dd>Adapter 转换得到的 CanonicalEvent。</dd>
            <dt>host-canonical</dt><dd>adapter-host 完成协议校验后的输出。</dd>
            <dt>runtime / worker</dt><dd>Agent Work Runtime 内部状态与 Worker 通道协议事件。</dd>
            <dt>control</dt><dd>丢帧、序号缺口和来源不可用等诊断事件。</dd>
          </dl>
        </div>
      </section>
    </div>,
    document.body
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
