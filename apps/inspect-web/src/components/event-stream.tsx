import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronRight,
  Copy,
  ExternalLink,
  Filter,
  Radio,
  RotateCcw,
  WrapText
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { InspectRecord } from "../domain";
import { cn } from "../lib/utils";

export interface ColumnFilters {
  stage: string;
  direction: string;
  adapter: string;
}

type PauseReason = "manual" | "scroll" | "expand";

interface EventStreamProps {
  records: readonly InspectRecord[];
  allRecords: readonly InspectRecord[];
  paused: boolean;
  pauseReason?: PauseReason;
  live: boolean;
  filters: ColumnFilters;
  onPause(reason: PauseReason): void;
  onResume(): void;
  onFiltersChange(filters: ColumnFilters): void;
  onQuickFilter(field: "type" | "agent_run_id" | "session_id" | "stage", value: string): void;
}

export function EventStream({
  records,
  allRecords,
  paused,
  pauseReason,
  live,
  filters,
  onPause,
  onResume,
  onFiltersChange,
  onQuickFilter
}: EventStreamProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const ignoreScrollRef = useRef(false);
  const preservedScrollTopRef = useRef<number | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const virtualizer = useVirtualizer({
    count: records.length,
    getScrollElement: () => parentRef.current,
    estimateSize: index => expanded.has(records[index]?.key ?? "") ? 520 : 45,
    getItemKey: index => records[index]?.key ?? index,
    overscan: 10
  });
  const latestKey = records[0]?.key;

  useLayoutEffect(() => {
    if (!paused && latestKey) {
      ignoreScrollRef.current = true;
      virtualizer.scrollToIndex(0, { align: "start" });
      const frame = requestAnimationFrame(() => { ignoreScrollRef.current = false; });
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [latestKey, paused, virtualizer]);

  useEffect(() => {
    const keys = new Set(records.map(record => record.key));
    setExpanded(current => {
      const next = new Set([...current].filter(key => keys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [records]);

  useLayoutEffect(() => {
    const scrollTop = preservedScrollTopRef.current;
    const viewport = parentRef.current;
    if (scrollTop === undefined || !viewport) return undefined;
    preservedScrollTopRef.current = undefined;

    let secondFrame = 0;
    viewport.scrollTop = scrollTop;
    const firstFrame = requestAnimationFrame(() => {
      viewport.scrollTop = scrollTop;
      secondFrame = requestAnimationFrame(() => { viewport.scrollTop = scrollTop; });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [expanded]);

  const options = useMemo(() => ({
    stages: uniqueValues(allRecords, record => record.stage),
    directions: uniqueValues(allRecords, record => record.direction),
    adapters: uniqueValues(allRecords, record => record.adapterType)
  }), [allRecords]);

  const toggle = (key: string): void => {
    preservedScrollTopRef.current = parentRef.current?.scrollTop;
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="event-stream">
      <div className="live-strip">
        <div className="live-strip__message">
          <span className="live-strip__arrow">↑</span>
          <strong>{paused ? "WS 接收已暂停" : live ? "实时推流处于活跃状态" : "实时连接当前不可用"}</strong>
          <span>{paused ? "· daemon sink 仍运行，暂停期间事件不补回" : "· 最新事件在顶部追加流入 (Prepend)"}</span>
          <span className="live-strip__divider">|</span>
          <span className="live-strip__detail">
            {paused ? pauseReasonLabel(pauseReason) : "视图已自动吸顶锁定"}
          </span>
        </div>
        <div className="live-strip__actions">
          <span>默认收起 · 点击整行展开载荷与诊断详情</span>
          <button type="button" onClick={() => {
            if (paused) onResume();
            else virtualizer.scrollToIndex(0, { align: "start", behavior: "smooth" });
          }}>
            {paused ? "恢复接收并定位最新" : "平滑定位最新"}
          </button>
        </div>
      </div>

      <div className="event-grid event-header">
        <span>序号</span>
        <HeaderSelect
          label="阶段"
          value={filters.stage}
          options={options.stages}
          onChange={stage => onFiltersChange({ ...filters, stage })}
        />
        <HeaderSelect
          label="流向"
          value={filters.direction}
          options={options.directions}
          onChange={direction => onFiltersChange({ ...filters, direction })}
        />
        <HeaderSelect
          label="适配器"
          value={filters.adapter}
          options={options.adapters}
          onChange={adapter => onFiltersChange({ ...filters, adapter })}
        />
        <span>事件与载荷</span>
        <span className="session-column">会话</span>
        <span className="run-column">运行</span>
        <span className="numeric-column">时间</span>
        <span className="duration-column numeric-column">耗时</span>
      </div>

      <div
        ref={parentRef}
        className="event-viewport"
        data-testid="event-viewport"
        onScroll={event => {
          if (ignoreScrollRef.current) return;
          const atTop = event.currentTarget.scrollTop <= 2;
          if (!paused && live && !atTop) onPause("scroll");
          if (paused && pauseReason === "scroll" && atTop) onResume();
        }}
      >
        {records.length === 0 ? (
          <div className="empty-state">
            <Radio aria-hidden="true" />
            <span>暂无匹配事件</span>
          </div>
        ) : (
          <div className="virtual-list" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map(item => {
              const record = records[item.index];
              if (!record) return null;
              const open = expanded.has(record.key);
              return (
                <article
                  key={record.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className={cn("event-item", `event-item--${record.status}`, item.index === 0 && live && !paused && "event-item--new")}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    className="event-grid event-row"
                    onPointerDown={event => {
                      if (open || !live || (event.target as HTMLElement).closest("button")) return;
                      onPause("expand");
                    }}
                    onClick={() => toggle(record.key)}
                    onKeyDown={event => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (!open && live) onPause("expand");
                        toggle(record.key);
                      }
                    }}
                  >
                    <span className="sequence-cell">
                      <ChevronRight className={cn("row-chevron", open && "row-chevron--open")} />
                      <b>{record.localSeq === undefined ? "-" : `#${record.localSeq}`}</b>
                      {item.index === 0 && live && <span className="new-dot" title="刚接收" />}
                    </span>
                    <StageBadge value={record.stage || record.source} />
                    <DirectionBadge value={record.direction} />
                    <AdapterBadge value={record.adapterType} />
                    <span className="event-summary">
                      {record.status !== "ok" && <AlertCircle aria-hidden="true" />}
                      <b>{record.type}</b>
                      <em>·</em>
                      <span>{record.summary}</span>
                    </span>
                    <Identifier className="session-column" value={record.sessionId} />
                    <Identifier className="run-column" value={record.runId} />
                    <time className="numeric-column event-time" dateTime={record.occurredAt}>{clock(record.occurredAt)}</time>
                    <Duration value={record.durationMs} />
                  </div>
                  {open && <EventDetail record={record} onQuickFilter={onQuickFilter} />}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function HeaderSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: readonly string[];
  onChange(value: string): void;
}) {
  return (
    <label className="header-select">
      <span>{value || label}</span>
      <select aria-label={`按${label}筛选`} value={value} onChange={event => onChange(event.target.value)}>
        <option value="">全部{label}</option>
        {options.map(option => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}

function StageBadge({ value }: { value: string }) {
  return <span className={cn("stage-badge", stageTone(value))} title={value}><i />{value || "unknown"}</span>;
}

function AdapterBadge({ value }: { value: string }) {
  return (
    <span className="adapter-badge" title={value || "未知适配器"}>
      <i />{value || "-"}
    </span>
  );
}

function stageTone(value: string): string {
  if (/^(adapter\.|native$)/.test(value)) return "stage-badge--adapter";
  if (value.startsWith("wire.")) return "stage-badge--wire";
  if (value.startsWith("host.")) return "stage-badge--host";
  if (value.startsWith("runtime.outbox")) return "stage-badge--outbox";
  if (value.startsWith("runtime.")) return "stage-badge--runtime";
  if (/^(worker\.|daemon(?:\.|$))/.test(value)) return "stage-badge--system";
  return "stage-badge--unknown";
}

function DirectionBadge({ value }: { value: string }) {
  if (value === "inbound") {
    return <span className="direction-badge direction-badge--in" title="入站 (inbound)"><ArrowDownToLine /></span>;
  }
  if (value === "outbound") {
    return <span className="direction-badge direction-badge--out" title="出站 (outbound)"><ArrowUpFromLine /></span>;
  }
  return <span className="direction-badge direction-badge--unknown" title="未知流向">-</span>;
}

function Identifier({ value, className }: { value: string; className?: string }) {
  const copy = (event: React.MouseEvent): void => {
    event.stopPropagation();
    if (value) void navigator.clipboard.writeText(value);
  };
  return (
    <span className={cn("identifier", className)} title={value || undefined}>
      <span>{value ? compactId(value) : "-"}</span>
      {value && <button type="button" aria-label={`复制 ${value}`} onClick={copy}><Copy /></button>}
    </span>
  );
}

function Duration({ value }: { value?: number }) {
  const tone = value === undefined ? "" : value >= 1000 ? "duration--slow" : value >= 300 ? "duration--medium" : "duration--fast";
  return <span className={cn("duration-column numeric-column duration", tone)}>{value === undefined ? "-" : `${Math.round(value)}ms`}</span>;
}

function EventDetail({ record, onQuickFilter }: {
  record: InspectRecord;
  onQuickFilter(field: "type" | "agent_run_id" | "session_id" | "stage", value: string): void;
}) {
  const [wrap, setWrap] = useState(false);
  const json = JSON.stringify(record.value, null, 2);
  const lines = json.split("\n");
  const copyJson = (): void => void navigator.clipboard.writeText(json);
  return (
    <section className="event-detail" onClick={event => event.stopPropagation()}>
      <div className="detail-heading">
        <div>
          <strong>{record.localSeq === undefined ? "事件" : `#${record.localSeq}`} 完整载荷与元数据</strong>
          <span>阶段: {record.stage || "-"}</span>
          <span>方向: {record.direction || "-"}</span>
        </div>
        <button type="button" className="detail-copy" onClick={copyJson}><Copy />复制 JSON</button>
      </div>

      <div className="context-grid">
        <ContextPanel title="请求上下文" entries={[
          ["Profile", record.profile],
          ["Adapter", record.adapterType],
          ["Source", record.source]
        ]} />
        <ContextPanel title="关联标识" entries={[
          ["Session", record.sessionId],
          ["Agent Run", record.runId],
          ["Invocation", record.invocationId]
        ]} />
        <ContextPanel title="时间与状态" entries={[
          ["Occurred At", record.occurredAt],
          ["Duration", record.durationMs === undefined ? "" : `${record.durationMs}ms`],
          ["Status", record.status]
        ]} />
      </div>

      {record.status !== "ok" && (
        <div className={cn("diagnostic-summary", `diagnostic-summary--${record.status}`)}>
          <AlertCircle />
          <div><strong>{record.status === "error" ? "事件异常" : "事件警告"}</strong><span>{record.summary}</span></div>
        </div>
      )}

      <div className="json-panel">
        <header>
          <span>原始事件 JSON</span>
          <div>
            <DarkAction label="切换自动换行" onClick={() => setWrap(value => !value)}><WrapText /></DarkAction>
            <DarkAction label="复制 JSON" onClick={copyJson}><Copy /></DarkAction>
            <button type="button" disabled><ExternalLink />独立弹窗（无实现）</button>
          </div>
        </header>
        <pre className={cn(wrap && "json-panel--wrap")}>
          {lines.map((line, index) => (
            <span className="json-line" key={`${index}:${line}`}><i>{index + 1}</i><code>{line || " "}</code></span>
          ))}
        </pre>
      </div>

      <footer className="detail-actions">
        <button type="button" disabled><RotateCcw />重放 Invocation（无实现）</button>
        <button type="button" onClick={() => onQuickFilter("type", record.type)}><Filter />仅看此类事件</button>
        <button type="button" disabled={!record.runId} onClick={() => onQuickFilter("agent_run_id", record.runId)}><Filter />过滤此次 AgentRun</button>
        <button type="button" disabled={!record.sessionId} onClick={() => onQuickFilter("session_id", record.sessionId)}><Filter />过滤此次 AgentSession</button>
        <button type="button" disabled={!record.stage} onClick={() => onQuickFilter("stage", record.stage)}><Filter />过滤当前 Stage</button>
        <button type="button" disabled><Copy />复制 cURL / RPC（无实现）</button>
      </footer>
    </section>
  );
}

function ContextPanel({ title, entries }: { title: string; entries: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="context-panel">
      <dt>{title}</dt>
      {entries.map(([label, value]) => (
        <div key={label}><span>{label}</span><dd title={value || undefined}>{value || "-"}</dd></div>
      ))}
    </dl>
  );
}

function DarkAction({ label, onClick, children }: { label: string; onClick(): void; children: React.ReactNode }) {
  return <button type="button" title={label} aria-label={label} onClick={onClick}>{children}</button>;
}

function uniqueValues(records: readonly InspectRecord[], select: (record: InspectRecord) => string): string[] {
  return [...new Set(records.map(select).filter(Boolean))].sort();
}

function pauseReasonLabel(reason: PauseReason | undefined): string {
  if (reason === "expand") return "展开详情时已断开 WS，当前画面保持不动";
  if (reason === "scroll") return "已离开顶部，滚回顶部可恢复接收";
  return "已手动断开 WS，点击恢复后只接收新事件";
}

function compactId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 13)}…` : value;
}

function clock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "-"
    : date.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3
    });
}
