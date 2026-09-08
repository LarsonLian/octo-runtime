import type { Agent, AgentRun, AgentSession } from "./store.js";

export interface HarnessContextInput {
  agent: Agent;
  agentSession: AgentSession;
  agentRun: AgentRun;
}

/** Build provider-neutral context from the unified execution objects only. */
export function composeContext({ agent, agentSession, agentRun }: HarnessContextInput): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schema: "octo-harness.agent-run-context/v1",
    agent: { id: agent.id, name: agent.name },
    agent_session: {
      id: agentSession.id,
      namespace: agentSession.namespace,
      session_key: agentSession.sessionKey,
      generation: agentSession.generation
    },
    agent_run: {
      id: agentRun.id,
      run_no: agentRun.runNo,
      trigger: agentRun.trigger,
      input: agentRun.input
    }
  });
}

export function renderPortableInstructions(context: Record<string, unknown>, perRun = ""): string {
  return [
    "[Harness Context]",
    JSON.stringify(context, null, 2),
    "[Harness Contract]",
    "Return work through the provider response stream. Use canonical Submit/AskUser tools when available. Do not call a business CLI merely to report completion.",
    perRun ? `[Run Instructions]\n${perRun}` : ""
  ].filter(Boolean).join("\n\n");
}
