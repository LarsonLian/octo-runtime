import type { Agent, Attempt, Session, Task, TriggerOccurrence } from "./store.js";

/** 组装一次 invocation 的结构化 Harness 上下文所需领域对象。 */
export interface HarnessContextInput {
  agent: Agent;
  session: Session;
  task?: Task;
  attempt?: Attempt;
  occurrence?: TriggerOccurrence;
}

/**
 * 从领域对象提取稳定、可序列化的最小上下文。
 * 不把完整 Agent config、provider session 或凭证放入 prompt，避免泄漏和 provider 耦合。
 */
export function composeContext({ agent, session, task, attempt, occurrence }: HarnessContextInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "octo-harness.context/v1",
    agent: { id: agent.id, name: agent.name },
    session: { id: session.id, type: session.type },
    task: task ? { id: task.id, title: task.title, description: task.description } : undefined,
    attempt: attempt ? { id: attempt.id, number: attempt.number } : undefined,
    trigger: occurrence ? { id: occurrence.id, kind: occurrence.kind, payload: occurrence.payload } : undefined
  });
}

/**
 * 把结构化上下文和本轮附加要求渲染成 provider-neutral 控制指令。
 * Adapter 决定具体 carrier，例如 Codex developer instructions、Claude system prompt file 或 OpenCode instructions。
 */
export function renderPortableInstructions(context: Record<string, unknown>, perTurn = ""): string {
  // harness 只追加可移植的执行契约；provider 私有参数由各 adapter 单独映射。
  return [
    "[Harness Context]",
    JSON.stringify(context, null, 2),
    "[Harness Contract]",
    "Return work through the provider response stream. Use canonical Submit/AskUser tools when available. Do not call a business CLI merely to report completion.",
    perTurn ? `[Per-Turn Instructions]\n${perTurn}` : ""
  ].filter(Boolean).join("\n\n");
}
