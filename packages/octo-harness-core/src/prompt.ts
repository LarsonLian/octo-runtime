import type { Agent, Attempt, Session, Task, TriggerOccurrence } from "./store.js";

/** Domain objects needed to assemble the structured Harness context for one invocation. */
export interface HarnessContextInput {
  agent: Agent;
  session: Session;
  task?: Task;
  attempt?: Attempt;
  occurrence?: TriggerOccurrence;
}

/**
 * Extract a stable, serializable, minimal context from the domain objects.
 * The full Agent config, provider session and credentials are deliberately kept
 * out of the prompt to avoid leaks and provider coupling.
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
 * Render the structured context and this turn's extra requirements into
 * provider-neutral control instructions. The adapter chooses the concrete
 * carrier, e.g. Codex developer instructions, a Claude system prompt file or
 * OpenCode instructions.
 */
export function renderPortableInstructions(context: Record<string, unknown>, perTurn = ""): string {
  // The harness only appends the portable execution contract; provider-private parameters are mapped by each adapter separately.
  return [
    "[Harness Context]",
    JSON.stringify(context, null, 2),
    "[Harness Contract]",
    "Return work through the provider response stream. Use canonical Submit/AskUser tools when available. Do not call a business CLI merely to report completion.",
    perTurn ? `[Per-Turn Instructions]\n${perTurn}` : ""
  ].filter(Boolean).join("\n\n");
}
