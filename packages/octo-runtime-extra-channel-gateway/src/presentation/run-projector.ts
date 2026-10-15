/**
 * 公开事件投影：将 CanonicalEvent 累积为平台无关的展示快照。
 * 按消息/工具/模型轮次保留身份与顺序，仅公开协议允许的内容；不展示私有 reasoning。
 */
import type { CanonicalEvent, FailureEnvelope } from "@mininglamp-oss/octo-runtime-protocol";
import { sanitizePublicValue } from "@mininglamp-oss/octo-runtime-adapter-sdk";

export interface ProgressItem {
  id: string;
  kind: "model_step" | "reasoning" | "commentary" | "tool";
  status: string;
  stepId?: string;
  content: string;
  toolName?: string;
  summary?: string;
  outcome?: "check_findings";
  exitCode?: number;
  finishReason?: string;
  startedAtMs?: number;
  durationMs?: number;
}
export interface RunPresentation {
  runId: string;
  seq: number;
  phase: string;
  label?: string;
  terminal?: "completed" | "failed" | "cancelled";
  elapsedMs?: number;
  items: ProgressItem[];
  reasoningCount: number;
  toolCallCount: number;
  modelStepCount: number;
  failure?: FailureEnvelope;
  failureMessage?: string;
  failureDetail?: string;
  resultUnknown?: boolean;
}

const publicExposures = new Set(["public_reasoning", "public_summary", "public_plan"]);

export class ImRunProjector {
  readonly #items = new Map<string, ProgressItem>();
  readonly #messages = new Map<string, { channel: string; text: string; stepId?: string }>();
  readonly #toolInputs = new Map<string, Record<string, unknown>>();
  #currentStep?: string;
  #seq = 0;
  #phase = "accepted";
  #label?: string;
  #startedAt?: number;
  #endedAt?: number;
  #terminal?: RunPresentation["terminal"];
  #failure?: FailureEnvelope;
  #failureMessage?: string;
  #failureDetail?: string;
  constructor(
    readonly runId: string,
    readonly allowToolPreview = false
  ) {}

  accept(event: CanonicalEvent, now = Date.now()): void {
    // 终态后不再接纳迟到帧，防止完成卡片被旧进度改回执行中。
    if (this.#terminal) return;
    this.#seq++;
    const p = event.payload;
    // 实际协议以 activity/model_step 启动计时，不能只等待历史 run.started。
    if (event.type === "activity.started" || event.type === "model_step.started")
      this.#startedAt ??= now;
    if (event.type === "run.started") {
      this.#startedAt ??= now;
      this.#phase = "model";
      this.#label = undefined;
    }
    if (event.type === "run.queued") this.#phase = "accepted";
    if (event.type === "model_step.started") {
      const p = event.payload;
      this.#currentStep = p.stepId;
      this.#item(`step:${p.stepId}`, "model_step", p.stepId).startedAtMs = p.startedAtMs;
      this.#phase = "model";
      this.#label = undefined;
    }
    if (event.type === "model_step.finished") {
      const p = event.payload;
      const item = this.#item(`step:${p.stepId}`, "model_step", p.stepId);
      item.status = p.status;
      item.finishReason = p.finishReason;
      if (item.startedAtMs !== undefined && p.endedAtMs !== undefined)
        item.durationMs = Math.max(0, p.endedAtMs - item.startedAtMs);
    }
    if (event.type.startsWith("message.")) {
      const id =
        p.messageId ??
        `unidentified:${p.stepId ?? this.#currentStep ?? "run"}:${p.channel ?? "final"}`;
      const previous = this.#messages.get(id);
      const channel = p.channel ?? previous?.channel ?? "final";
      // analysis 必须显式声明可公开；历史片段也清除，避免后续快照泄漏。
      if (channel === "analysis" && !publicExposures.has(p.exposure ?? "")) {
        this.#messages.delete(id);
        this.#items.delete(`message:${id}`);
        return;
      }
      if (
        !["analysis", "commentary", "final"].includes(channel) ||
        (p.role && p.role !== "assistant")
      )
        return;
      const text =
        typeof p.text !== "string"
          ? (previous?.text ?? "")
          : event.type === "message.delta"
            ? (previous?.text ?? "") + p.text
            : p.text;
      const stepId = p.stepId ?? previous?.stepId ?? this.#currentStep;
      this.#messages.set(id, { channel, text, stepId });
      if (channel !== "final") {
        const item = this.#item(
          `message:${id}`,
          channel === "analysis" ? "reasoning" : "commentary",
          stepId
        );
        item.content = text;
        item.status = event.type === "message.update" ? "completed" : "running";
      }
      if (channel === "final" && stepId && this.#items.has(`step:${stepId}`)) {
        this.#items.get(`step:${stepId}`)!.content = [...this.#messages.values()]
          .filter((message) => message.channel === "final" && message.stepId === stepId)
          .map((message) => message.text)
          .join("\n\n");
      }
      this.#phase =
        channel === "final" ? "answering" : channel === "analysis" ? "thinking" : "commentary";
      this.#label = undefined;
    }
    if (event.type === "tool_call.create") {
      const p = event.payload;
      const item = this.#item(`tool:${p.id}`, "tool", p.stepId ?? this.#currentStep);
      item.toolName = p.name;
      item.startedAtMs = now;
      if (this.allowToolPreview) item.summary = toolPreview(p.name, p.args);
      const command = stringArg(p.args.command ?? p.args.cmd);
      if (command.length <= 8192) this.#toolInputs.set(p.id, { command });
      this.#phase = "tool";
      this.#label = undefined;
    }
    if (event.type === "tool_call.update") {
      const p = event.payload;
      const item = this.#item(`tool:${p.id}`, "tool", p.stepId ?? this.#currentStep);
      item.status = p.status;
      item.exitCode = p.exitCode;
      item.durationMs =
        p.durationMs ??
        (item.startedAtMs === undefined ? undefined : Math.max(0, now - item.startedAtMs));
      const input = this.#toolInputs.get(p.id);
      if (p.status === "failed" && p.exitCode === 2 && input && detectorFindings(input, p.output))
        item.outcome = "check_findings";
      this.#toolInputs.delete(p.id);
      this.#phase = "tool";
      this.#label = "工具调用完成";
    }
    if (event.type === "activity.started") {
      const p = event.payload;
      const phases: Record<string, string> = {
        thinking: "thinking",
        executing_tool: "tool",
        responding: "answering",
        starting: "accepted",
        waiting_input: "waiting",
        waiting_approval: "waiting",
        compacting: "model",
        retrying: "model",
        working: "model"
      };
      this.#phase = phases[p.kind] ?? "model";
      this.#label = undefined;
    }
    if (event.type === "interaction.requested") {
      this.#phase = "waiting";
      this.#label = "等待你的确认或输入";
    }
    if (event.type === "interaction.resolved") {
      this.#phase = "model";
      this.#label = undefined;
    }
    if (event.type === "run.notice") {
      const p = event.payload;
      const labels: Record<string, string> = {
        retry_scheduled: "正在重试",
        context_compacted: "上下文已压缩",
        model_rerouted: "已切换模型",
        config_warning: "执行配置提示"
      };
      this.#label = labels[p.code];
    }
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      this.#terminal =
        event.type === "run.completed"
          ? "completed"
          : event.type === "run.failed"
            ? "failed"
            : "cancelled";
      this.#endedAt = now;
      this.#failure = p.failure;
      if (event.type === "run.failed") {
        const message = sanitizePublicValue(p.message);
        const error = sanitizePublicValue(p.error);
        this.#failureMessage = typeof message === "string" && message.trim() ? message : undefined;
        const detail =
          typeof error === "string"
            ? error
            : error && typeof error === "object"
              ? JSON.stringify(error, null, 2)
              : undefined;
        this.#failureDetail =
          detail && detail !== this.#failureMessage
            ? [this.#failureMessage, detail].filter(Boolean).join("\n")
            : this.#failureMessage || detail;
      }
      for (const item of this.#items.values())
        if (item.status === "running")
          item.status = this.#terminal === "completed" ? "completed" : "cancelled";
    }
    if (
      this.#items.size > 512 ||
      this.#messages.size > 512 ||
      [...this.#messages.values()].reduce(
        (size, message) => size + Buffer.byteLength(message.text),
        0
      ) >
        256 * 1024
    )
      throw new Error("IM_RESULT_TOO_LARGE");
  }

  #item(id: string, kind: ProgressItem["kind"], stepId?: string): ProgressItem {
    let item = this.#items.get(id);
    if (!item) {
      item = { id, kind, stepId, status: "running", content: "" };
      this.#items.set(id, item);
    }
    return item;
  }
  get finalText(): string {
    return [...this.#messages.values()]
      .filter((m) => m.channel === "final")
      .map((m) => m.text)
      .filter(Boolean)
      .join("\n\n");
  }
  snapshot(now = Date.now()): RunPresentation {
    const items = structuredClone([...this.#items.values()]);
    return {
      runId: this.runId,
      seq: this.#seq,
      phase: this.#phase,
      label: this.#label,
      terminal: this.#terminal,
      elapsedMs:
        this.#startedAt === undefined
          ? undefined
          : Math.max(0, (this.#endedAt ?? now) - this.#startedAt),
      items,
      reasoningCount: items.filter((i) => i.kind === "reasoning").length,
      toolCallCount: items.filter((i) => i.kind === "tool").length,
      modelStepCount: items.filter((i) => i.kind === "model_step").length,
      failure: this.#failure,
      failureMessage: this.#failureMessage,
      failureDetail: this.#failureDetail
    };
  }
}

export function clampRunes(value: string, maximum: number): string {
  const runes = Array.from(value);
  return runes.length <= maximum ? value : runes.slice(0, Math.max(0, maximum - 1)).join("") + "…";
}
export function compactRunes(value: string, maximum: number): string {
  const runes = Array.from(value);
  if (runes.length <= maximum) return value;
  const head = Math.floor(((maximum - 3) * 2) / 3);
  return runes.slice(0, head).join("") + " … " + runes.slice(-(maximum - 3 - head)).join("");
}
export function toolPreview(name: string, args: Record<string, unknown>): string {
  const sensitive =
    /token|secret|password|passwd|credential|authorization|cookie|api_key|apikey|\.env|id_rsa|id_ed25519|private_key|sk-|bf_|ghp_|xoxb-/i;
  if (["exec_command", "shell", "bash", "sh", "zsh"].includes(name.toLowerCase())) {
    let command = stringArg(args.command ?? args.cmd).trim();
    if (sensitive.test(command) || command.includes("\0")) return "";
    command = command.replace(
      /^(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|fish)\s+-[a-z]*c[a-z]*\s+(['"])([\s\S]*)\1$/,
      "$2"
    );
    return clampRunes(command.replace(/\s+/g, " ").trim(), 42);
  }
  if (["read", "read_file", "write_file", "file_read", "file_write"].includes(name.toLowerCase())) {
    const path = stringArg(args.path ?? args.file_path ?? args.filePath).replace(/\\/g, "/");
    if (sensitive.test(path) || /:\/\/|[\r\n\0]/.test(path)) return "";
    const parts = path
      .split("/")
      .filter((p) => p && p !== "." && p !== "..")
      .slice(-2);
    return parts.every((p) => /^[\p{L}\p{N}._+~ -]+$/u.test(p)) && parts.length
      ? clampRunes("…/" + parts.join("/"), 96)
      : "";
  }
  return "";
}
function detectorFindings(input: Record<string, unknown>, output: unknown): boolean {
  const command = stringArg(input.command ?? input.cmd);
  if (!/\bdetect\b/.test(command) || !/--json\b/.test(command)) return false;
  try {
    const findings = typeof output === "string" ? (JSON.parse(output) as unknown) : output;
    return (
      Array.isArray(findings) &&
      findings.some((f: unknown) => {
        if (!f || typeof f !== "object") return false;
        const value = (f as Record<string, unknown>).antipattern;
        return typeof value === "string" && !!value.trim();
      })
    );
  } catch {
    return false;
  }
}
function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}
