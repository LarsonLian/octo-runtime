import { stderr } from "node:process";
import { styleText } from "node:util";
import type { LogLevel, RecordEnvelope } from "@mininglamp-oss/octo-harness-observability";

type TerminalStream = typeof stderr;
type Style = "cyan" | "green" | "red" | "yellow";

interface Presentation {
  symbol: string;
  style: Style;
}

const PRESENTATIONS: Record<string, Presentation> = {
  "adapter_host.restart_scheduled": { symbol: "!", style: "yellow" },
  "adapter_host.restarted": { symbol: "✓", style: "green" },
  "adapter_host.restart_failed": { symbol: "✗", style: "red" },
  "adapter_host.unexpected_exit": { symbol: "✗", style: "red" },
  "agent_work.registration.started": { symbol: "●", style: "cyan" },
  "agent_work.registration.completed": { symbol: "✓", style: "green" },
  "agent_work.runtime.ready": { symbol: "✓", style: "green" },
  "agent_work.command.received": { symbol: "←", style: "cyan" },
  "agent_work.outbox.hard_watermark": { symbol: "✗", style: "red" },
  "daemon.ready": { symbol: "✓", style: "green" },
  "daemon.stopping": { symbol: "●", style: "yellow" },
  "daemon.stopped": { symbol: "✓", style: "green" },
  "run.execution.started": { symbol: "→", style: "cyan" },
  "run.execution.completed": { symbol: "✓", style: "green" },
  "run.execution.failed": { symbol: "✗", style: "red" },
  "transport.connection.connecting": { symbol: "●", style: "cyan" },
  "transport.connection.opened": { symbol: "✓", style: "green" },
  "transport.connection.closed": { symbol: "!", style: "yellow" },
  "transport.connection.failed": { symbol: "✗", style: "red" }
};

export interface DaemonConsoleOutputOptions {
  verbose?: boolean;
  stream?: TerminalStream;
}

/** Render redacted operational records for an interactive foreground daemon. */
export function createDaemonConsoleOutput({
  verbose = false,
  stream = stderr
}: DaemonConsoleOutputOptions = {}): (record: RecordEnvelope) => void {
  return record => {
    const line = formatDaemonConsoleRecord(record, { verbose, stream });
    if (line) stream.write(`${line}\n`);
  };
}

export function formatDaemonConsoleRecord(
  record: RecordEnvelope,
  { verbose = false, stream = stderr }: DaemonConsoleOutputOptions = {}
): string | undefined {
  if (verbose) return verboseLine(record, stream);

  const presentation = concisePresentation(record);
  if (!presentation) return undefined;
  const symbol = styleText([presentation.style, "bold"], presentation.symbol, { stream });
  const message = capitalize(record.message);
  const detail = conciseDetail(record);
  return `${symbol} ${message}${detail ? ` ${styleText("gray", detail, { stream })}` : ""}`;
}

function concisePresentation(record: RecordEnvelope): Presentation | undefined {
  // The entrypoint renders startup failures once, with an optional full trace.
  if (record.event === "daemon.start.failed") return undefined;
  if (record.event === "transport.connection.opened" && record.scope !== "transport.wss") return undefined;
  if (record.event === "transport.connection.closed" && record.scope !== "transport.wss") return undefined;
  return PRESENTATIONS[record.event]
    ?? (record.level === "error" ? { symbol: "✗", style: "red" } : undefined)
    ?? (record.level === "warn" ? { symbol: "!", style: "yellow" } : undefined);
}

function conciseDetail(record: RecordEnvelope): string | undefined {
  const data = objectValue(record.data);
  const parts = [
    pair("runtime", stringValue(data?.runtime_key)),
    pair("run", stringValue(record.run_key)),
    pair("adapter", stringValue(record.adapter_type)),
    pair("pid", numberValue(data?.pid)),
    pair("type", stringValue(data?.command_type)),
    pair("attempt", numberValue(data?.reconnect_attempt)),
    pair("code", numberValue(data?.close_code)),
    pair("error", stringValue(data?.error))
  ].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function verboseLine(record: RecordEnvelope, stream: TerminalStream): string {
  const level = record.level.toUpperCase().padEnd(5);
  const style = levelStyle(record.level);
  const timestamp = record.ts.slice(11, 23);
  const context = conciseDetail(record);
  const data = objectValue(record.data);
  const serializedData = data && Object.keys(data).length > 0 ? JSON.stringify(data) : undefined;
  return [
    styleText("gray", timestamp, { stream }),
    styleText([style, "bold"], level, { stream }),
    record.event,
    record.message,
    context,
    serializedData
  ].filter((value): value is string => Boolean(value)).join(" ");
}

function levelStyle(level: LogLevel): Style {
  if (level === "error") return "red";
  if (level === "warn") return "yellow";
  if (level === "info") return "green";
  return "cyan";
}

function pair(name: string, value: string | number | undefined): string | undefined {
  return value === undefined ? undefined : `${name}=${value}`;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}
