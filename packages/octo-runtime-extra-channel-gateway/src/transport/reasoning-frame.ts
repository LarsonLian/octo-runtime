/**
 * 模板展示转换：把公开快照映射到服务端卡片合同，保留文字与工具交替的执行阶段。
 * 复用原服务端展示规则，限制阶段/动作/字符/字节预算；最终正文由独立消息承载。
 */
// Port of octo-agent-app-channel/internal/transport/progress.go display rules.
import { failureMessage } from "@mininglamp-oss/octo-runtime-protocol";
import type { CardTemplateRef } from "./api/cards.js";
import {
  clampRunes,
  compactRunes,
  type ProgressItem,
  type RunPresentation
} from "../presentation/run-projector.js";

export interface ReasoningAction {
  tool: string;
  detail: string;
  statusGlyph: string;
  statusTone: string;
}
export interface ReasoningPhase {
  thought: string;
  actions: ReasoningAction[];
}
export interface ReasoningFrame {
  reasoningId: string;
  state: string;
  title: string;
  statusLabel: string;
  statusTone: string;
  timerText?: string;
  traceExpanded: boolean;
  traceCollapsed: boolean;
  collapsedSummary: string;
  progressText?: string;
  phases: ReasoningPhase[];
  errorTitle?: string;
  errorMessage?: string;
}
export interface ReasoningTemplate {
  ref: CardTemplateRef;
  maxPayloadBytes: number;
}

export function formatDuration(ms: number): string {
  ms = Math.max(0, ms);
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}
function thought(text: string): string {
  text = text.replace(/\s+/g, " ").trim();
  if (/OPENCLAW_INTERNAL/i.test(text)) return "Reasoning summary hidden";
  return text ? compactRunes(text, 180) : "—";
}
function toolName(name = "tool"): string {
  name = name.replace(/\s+/g, " ").trim();
  if (!name || name.includes("://")) name = "tool";
  name = clampRunes(name, 80);
  if (name === "think") return "💭 思考";
  const lower = name.toLowerCase();
  if (/read/.test(lower)) return "📖 " + name;
  if (/exec|shell/.test(lower) || lower === "bash") return "⌨️ " + name;
  if (/search|find|grep/.test(lower)) return "🔎 " + name;
  if (/write|edit/.test(lower)) return "✏️ " + name;
  return "🔧 " + name;
}
function action(item: ProgressItem): ReasoningAction {
  const running =
    !item.status || ["running", "started", "in_progress", "pending"].includes(item.status);
  const failed = item.status === "failed" || item.status === "error";
  const command =
    ["exec_command", "shell", "bash", "sh", "zsh"].includes(item.toolName?.toLowerCase() ?? "") &&
    !!item.summary;
  let detail = running
    ? "进行中…"
    : failed
      ? "调用失败"
      : item.status === "cancelled"
        ? "已中断"
        : "已完成";
  let tone = running
    ? "Accent"
    : failed
      ? "Attention"
      : item.status === "cancelled"
        ? "Attention"
        : "Good";
  if (item.outcome === "check_findings") {
    detail = "检查发现问题";
    tone = "Attention";
  }
  const parts = [
    item.summary ? clampRunes(item.summary, command ? 42 : 96) : "",
    command && item.exitCode !== undefined && !item.outcome ? `exit ${item.exitCode}` : detail,
    item.durationMs !== undefined ? formatDuration(item.durationMs) : ""
  ].filter(Boolean);
  return {
    tool: clampRunes(
      command ? "exec" : item.kind === "model_step" ? "模型输出" : toolName(item.toolName),
      81
    ),
    detail: clampRunes(parts.join(" · "), 192),
    statusGlyph: item.outcome === "check_findings" ? "!" : "●",
    statusTone: tone
  };
}

export function reasoningPhases(snapshot: RunPresentation): ReasoningPhase[] {
  const steps = snapshot.items.filter((i) => i.kind === "model_step");
  let phases: ReasoningPhase[];
  if (steps.length) {
    phases = steps.flatMap((step, index) => {
      const children = snapshot.items.filter(
        (i) => i.stepId === step.stepId && i.kind !== "model_step"
      );
      // 与 WorkApp processSegments 对齐：新的 commentary 消息划分阶段，工具跟随其前的文字。
      // 同一 messageId 的 delta 已由 projector 合并，不会每个字都新建阶段。
      const segments: ProgressItem[][] = [[]];
      for (const child of children) {
        if (child.kind === "commentary" && child.content.trim() && segments.at(-1)!.length)
          segments.push([]);
        segments.at(-1)!.push(child);
      }
      return segments.map((children, segmentIndex) => {
        const commentary = children.filter((i) => i.kind === "commentary" && i.content.trim());
        const reasoning = children.filter((i) => i.kind === "reasoning" && i.content.trim());
        const text =
          (commentary.length ? commentary : reasoning).map((i) => thought(i.content)).join("\n") ||
          (segmentIndex === segments.length - 1 && step.content ? thought(step.content) : "");
        const label = ["tool-calls", "tool_calls", "tool-use", "tool_use"].includes(
          step.finishReason ?? ""
        )
          ? "分析并调用工具"
          : ["stop", "end_turn", "completed"].includes(step.finishReason ?? "")
            ? "整理回答"
            : "模型处理";
        let heading = `第 ${index + 1} 轮 · ${label}${step.durationMs === undefined ? "" : " · " + formatDuration(step.durationMs)}`;
        if (segments.length > 1) heading += ` · 阶段 ${segmentIndex + 1}`;
        const failed = children.some(
          (i) => i.kind === "tool" && i.status === "failed" && i.outcome !== "check_findings"
        );
        if (failed) heading += " · 部分失败";
        const actions: ReasoningAction[] = [];
        if (reasoning.length) {
          const thinking = action({ ...reasoning[0], toolName: "think" });
          if (failed) {
            thinking.detail = "已结束 · 工具有失败";
            thinking.statusGlyph = "×";
            thinking.statusTone = "Attention";
          }
          actions.push(thinking);
        }
        actions.push(...children.filter((i) => i.kind === "tool").map(action));
        if (!actions.length) actions.push(action(step));
        return { thought: heading + (text ? "：" + text : ""), actions };
      });
    });
  } else {
    phases = [];
    for (const item of snapshot.items) {
      if (item.kind === "commentary" || item.kind === "reasoning")
        phases.push({
          thought: thought(item.content),
          actions: item.kind === "reasoning" ? [action({ ...item, toolName: "think" })] : []
        });
      else if (item.kind === "tool") {
        if (!phases.length) phases.push({ thought: "执行工具", actions: [] });
        phases.at(-1)!.actions.push(action(item));
      }
    }
    if (!phases.length)
      phases.push({
        thought: "—",
        actions: [
          {
            tool: "任务状态",
            detail: snapshot.terminal ? "已结束" : "处理中",
            statusGlyph: "●",
            statusTone: snapshot.terminal ? "Good" : "Accent"
          }
        ]
      });
    for (const phase of phases)
      if (!phase.actions.length)
        phase.actions.push({
          tool: "进度",
          detail: snapshot.terminal ? "已结束" : "进行中…",
          statusGlyph: "●",
          statusTone: "Accent"
        });
  }
  // 模板最多展示三阶段、八动作；保留近期过程，并给每个可见阶段留一个动作位置。
  phases = phases.slice(-3);
  let remaining = 8;
  for (let index = phases.length - 1; index >= 0; index--) {
    const phase = phases[index];
    const available = Math.max(1, remaining - index);
    if (phase.actions.length > available)
      phase.actions = [
        phase.actions[0],
        ...phase.actions.slice(-(available - 1 || phase.actions.length))
      ].slice(0, available);
    remaining -= phase.actions.length;
  }
  return phases;
}

export function buildReasoningFrame(
  snapshot: RunPresentation,
  template: ReasoningTemplate
): ReasoningFrame | undefined {
  const elapsed = snapshot.elapsedMs === undefined ? "" : formatDuration(snapshot.elapsedMs);
  const steps = Math.max(snapshot.modelStepCount, snapshot.reasoningCount + snapshot.toolCallCount);
  const counts = `思考 ${snapshot.reasoningCount} · 工具 ${snapshot.toolCallCount} · ${steps} 步`;
  const summary = elapsed ? elapsed + " · " + counts : counts;
  const labels: Record<string, [string, string]> = {
    accepted: ["思考中", "正在处理请求"],
    thinking: ["思考中", "正在分析"],
    tool: ["调用工具中", "正在调用工具"],
    commentary: ["同步进度", "正在同步进度"],
    model: ["处理中", "模型处理中"],
    answering: ["生成回复中", "正在组织回复"],
    waiting: ["等待确认", "等待你的确认或输入"]
  };
  const [status, label] = labels[snapshot.phase] ?? labels.model;
  const frame: ReasoningFrame = {
    reasoningId: clampRunes(snapshot.runId, 128),
    state: snapshot.phase === "answering" ? "answering" : "reasoning",
    title: "推理与工具调用 · " + counts,
    statusLabel: snapshot.label === "工具调用完成" ? snapshot.label : status,
    statusTone: "Accent",
    // 模板要求 timerText 非空；尚未计时时省略，空字符串会令整个编辑请求被拒绝。
    ...(elapsed ? { timerText: elapsed } : {}),
    traceExpanded: true,
    traceCollapsed: false,
    collapsedSummary: summary,
    progressText: (snapshot.label ?? label) + (elapsed ? " · 已耗时 " + elapsed : ""),
    phases: reasoningPhases(snapshot)
  };
  if (snapshot.phase === "accepted" && !snapshot.terminal) {
    // 第一帧立即显示思考中，只展示状态，不伪造 reasoning 内容或计数。
    frame.title = "思考中";
    frame.traceExpanded = false;
    frame.traceCollapsed = true;
    frame.collapsedSummary = "正在处理请求";
    frame.phases = [
      {
        thought: "正在处理请求",
        actions: [{ tool: "任务状态", detail: "思考中", statusGlyph: "●", statusTone: "Accent" }]
      }
    ];
  }
  if (snapshot.terminal) {
    frame.state =
      snapshot.terminal === "completed"
        ? "completed"
        : snapshot.terminal === "cancelled"
          ? "stopped"
          : "error";
    frame.statusLabel =
      snapshot.terminal === "completed"
        ? "已完成"
        : snapshot.terminal === "cancelled"
          ? "已中断"
          : "失败";
    frame.statusTone =
      snapshot.terminal === "completed"
        ? "Good"
        : snapshot.terminal === "cancelled"
          ? "Warning"
          : "Attention";
    frame.traceExpanded = false;
    frame.traceCollapsed = true;
    delete frame.progressText;
    frame.collapsedSummary =
      summary +
      (snapshot.terminal === "completed"
        ? " · 已收起"
        : snapshot.terminal === "cancelled"
          ? " · 已保留完成步骤"
          : " · 展开查看失败前步骤");
    if (snapshot.terminal === "failed") {
      frame.errorTitle = "执行失败";
      frame.errorMessage =
        snapshot.failureMessage ||
        snapshot.failureDetail ||
        (snapshot.failure
          ? failureMessage(snapshot.failure.code)
          : "任务执行失败，系统未返回具体原因。");
      const actions: Record<string, string> = {
        retry: "重试",
        retry_later: "稍后重试",
        update_credentials: "更新凭据",
        change_model: "更换模型",
        check_runtime: "检查运行设备",
        install_dependency: "安装依赖",
        fix_permissions: "检查权限",
        contact_admin: "联系管理员"
      };
      const actionLabel = snapshot.failure ? actions[snapshot.failure.action.type] : "查看运行记录";
      frame.phases = [
        ...frame.phases.slice(-2).map((phase) => ({ ...phase, actions: phase.actions.slice(-3) })),
        {
          thought: snapshot.failureDetail || frame.errorMessage,
          actions: [
            {
              tool: actionLabel || "查看运行记录",
              detail:
                [snapshot.failure?.code, snapshot.failure?.diagnosticId]
                  .filter(Boolean)
                  .join(" · ") || "系统未返回诊断编号",
              statusGlyph: "!",
              statusTone: "Attention"
            }
          ]
        }
      ];
      const identity = snapshot.failure
        ? `\n错误码：${snapshot.failure.code}\n诊断编号：${snapshot.failure.diagnosticId}`
        : "";
      frame.errorMessage =
        clampRunes(frame.errorMessage, Math.max(1, 121 - Array.from(identity).length)) + identity;
    }
  }
  const thoughtMax = template.ref.version === "0.4.0" ? 4000 : 280;
  if (snapshot.resultUnknown) {
    frame.state = "stopped";
    frame.statusLabel = "结果未知";
    frame.statusTone = "Warning";
    frame.traceExpanded = false;
    frame.traceCollapsed = true;
    delete frame.progressText;
    frame.collapsedSummary = "执行事件流中断，请查看运行记录，避免重复执行。";
  }
  if (snapshot.replyAssessment === "needs_verification") {
    frame.state = "stopped";
    frame.statusLabel = "结果待核查";
    frame.statusTone = "Warning";
    frame.traceExpanded = false;
    frame.traceCollapsed = true;
    delete frame.progressText;
    frame.collapsedSummary = "执行已结束，但未收到可确认的回复。请核查任务结果，避免重复执行。";
  }
  if (snapshot.replyAssessment === "empty" && snapshot.terminal === "completed")
    frame.statusLabel = "已结束";
  if (snapshot.providerDiagnostic) {
    const diagnostic = snapshot.providerDiagnostic;
    frame.phases = [
      ...frame.phases.slice(-2).map((phase) => ({ ...phase, actions: phase.actions.slice(-3) })),
      {
        thought: diagnostic.message,
        actions: [
          {
            tool: "过程诊断",
            detail: diagnostic.diagnosticId,
            statusGlyph: "!",
            statusTone: "Attention"
          }
        ]
      }
    ];
  }
  for (const phase of frame.phases) phase.thought = clampRunes(phase.thought, thoughtMax);
  let total = frame.phases.reduce((size, phase) => size + Array.from(phase.thought).length, 0);
  for (const phase of frame.phases) {
    if (total <= 540) break;
    const before = Array.from(phase.thought).length;
    phase.thought = clampRunes(phase.thought, Math.max(1, before - (total - 540)));
    total -= before - Array.from(phase.thought).length;
  }
  const budget = template.maxPayloadBytes - 128;
  // 字符限制不能替代 UTF-8 字节预算；预留报文开销后再收缩正文，避免服务端拒收。
  const fits = (): boolean =>
    Buffer.byteLength(
      JSON.stringify({ type: 17, template_ref: template.ref, state: frame.state, data: frame })
    ) <= budget;
  if (fits()) return frame;
  for (const phase of frame.phases) {
    const original = Array.from(phase.thought);
    phase.thought = "—";
    if (!fits()) continue;
    let low = 1,
      high = original.length - 1,
      best = 0;
    while (low <= high) {
      const keep = Math.floor((low + high) / 2);
      phase.thought = original.slice(0, keep).join("") + "…";
      if (fits()) {
        best = keep;
        low = keep + 1;
      } else high = keep - 1;
    }
    phase.thought = best ? original.slice(0, best).join("") + "…" : "—";
    return frame;
  }
  return fits() ? frame : undefined;
}
