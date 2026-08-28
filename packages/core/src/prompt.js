export function composeContext({ agent, session, task, attempt, occurrence }) {
  return Object.freeze({
    schema: "orbtex.context/v1",
    agent: { id: agent.id, name: agent.name },
    session: { id: session.id, type: session.type },
    task: task ? { id: task.id, title: task.title, description: task.description } : undefined,
    attempt: attempt ? { id: attempt.id, number: attempt.number } : undefined,
    trigger: occurrence ? { id: occurrence.id, kind: occurrence.kind, payload: occurrence.payload } : undefined
  });
}

export function renderPortableInstructions(context, perTurn = "") {
  return [
    "[Harness Context]",
    JSON.stringify(context, null, 2),
    "[Harness Contract]",
    "Return work through the provider response stream. Use canonical Submit/AskUser tools when available. Do not call a business CLI merely to report completion.",
    perTurn ? `[Per-Turn Instructions]\n${perTurn}` : ""
  ].filter(Boolean).join("\n\n");
}
