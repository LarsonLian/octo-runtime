import { envelope, isTerminal } from "@orbtex-ai/protocol";
import { randomUUID } from "node:crypto";
import { composeContext, renderPortableInstructions } from "./prompt.js";

const id = prefix => `${prefix}_${randomUUID()}`;

export class HarnessEngine {
  constructor({ store, host }) { this.store = store; this.host = host; }

  async registerAgent(input) {
    if (!input.name || !input.adapterType) throw new Error("agent name and adapterType are required");
    const adapters = await this.host.list();
    if (!adapters.some(item => item.type === input.adapterType)) throw new Error(`adapter not loaded: ${input.adapterType}`);
    const agent = { id: input.id ?? id("agent"), name: input.name, adapterType: input.adapterType, config: input.config ?? {} };
    this.store.agents.set(agent.id, agent); await this.store.commit(); return agent;
  }

  async createTrigger(input) {
    if (!this.store.agents.has(input.agentId)) throw new Error(`agent not found: ${input.agentId}`);
    if (!input.task?.title || !input.task?.description) throw new Error("trigger.task title and description are required");
    if (!new Set(["manual", "event", "interval"]).has(input.kind)) throw new Error(`unsupported trigger kind: ${input.kind}`);
    if (input.kind === "event" && !input.eventType) throw new Error("event trigger requires eventType");
    if (input.kind === "interval" && (!Number.isFinite(input.everyMs) || input.everyMs < 1000)) throw new Error("interval trigger requires everyMs >= 1000");
    const trigger = { id: input.id ?? id("trigger"), enabled: true, ...input };
    this.store.triggers.set(trigger.id, trigger); await this.store.commit(); return trigger;
  }

  async materializeTrigger(triggerId, { externalEventId, payload = {} }) {
    const trigger = this.store.triggers.get(triggerId);
    if (!trigger?.enabled) throw new Error("trigger is missing or disabled");
    if (typeof externalEventId !== "string" || !externalEventId) throw new Error("externalEventId is required");
    const dedupeKey = `${triggerId}:${externalEventId}`;
    const existing = this.store.occurrences.get(dedupeKey);
    if (existing) return { deduplicated: true, occurrence: existing, task: this.store.tasks.get(existing.taskId) };
    const occurrence = { id: id("occ"), triggerId, externalEventId, kind: trigger.kind, payload, createdAt: Date.now() };
    const task = { id: id("task"), title: trigger.task.title, description: trigger.task.description, agentId: trigger.agentId, status: "queued", sessionId: id("session"), createdAt: Date.now() };
    occurrence.taskId = task.id;
    this.store.occurrences.set(dedupeKey, occurrence);
    this.store.tasks.set(task.id, task);
    this.store.sessions.set(task.sessionId, { id: task.sessionId, type: "task", status: "active" });
    await this.store.commit();
    return { deduplicated: false, occurrence, task };
  }

  async createChatSession({ agentId, title = "New chat", channel = "local" }) {
    if (!this.store.agents.has(agentId)) throw new Error(`agent not found: ${agentId}`);
    const session = { id: id("session"), type: "chat", agentId, title, channel, status: "active", createdAt: Date.now() };
    this.store.sessions.set(session.id, session); await this.store.commit(); return session;
  }

  async queueChatTurn(sessionId, prompt) {
    const session = this.store.sessions.get(sessionId);
    if (!session || session.type !== "chat") throw new Error(`chat session not found: ${sessionId}`);
    if (session.activeRunId) throw new Error(`chat already has an active run: ${session.activeRunId}`);
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("chat prompt is required");
    const run = { id: id("run"), sessionId, status: "queued", nextSeq: 1, prompt };
    session.activeRunId = run.id; this.store.runs.set(run.id, run);
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { sourceType: "chat" } }));
    await this.store.commit(); return { session, run };
  }

  async queueTask(taskId, { occurrenceId, sourceType = "manual", sourceId } = {}) {
    const task = this.store.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.activeRunId) throw new Error(`task already has an active run: ${task.activeRunId}`);
    const prior = [...this.store.attempts.values()].filter(item => item.taskId === taskId);
    const attempt = { id: id("attempt"), taskId, number: prior.length + 1, status: "queued", triggerOccurrenceId: occurrenceId, sourceType, sourceId };
    const run = { id: id("run"), sessionId: task.sessionId, attemptId: attempt.id, status: "queued", nextSeq: 1 };
    attempt.runId = run.id; task.activeRunId = run.id; task.status = "queued";
    this.store.attempts.set(attempt.id, attempt); this.store.runs.set(run.id, run);
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.queued", payload: { attemptId: attempt.id } }));
    await this.store.commit();
    return { task, attempt, run };
  }

  async executeRun(runId, perTurn = "") {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status !== "queued") throw new Error(`run is not queued: ${run.status}`);
    const attempt = run.attemptId ? this.store.attempts.get(run.attemptId) : undefined;
    const task = attempt ? this.store.tasks.get(attempt.taskId) : undefined;
    const session = this.store.sessions.get(run.sessionId);
    const agent = this.store.agents.get(task?.agentId ?? session?.agentId);
    if (!agent) throw new Error(`agent not found for run: ${run.id}`);
    run.status = "running";
    if (attempt) attempt.status = task.status = "running";
    this.store.appendEvent(envelope(run, run.nextSeq++, { type: "run.running", payload: {} }));
    await this.store.commit();

    const occurrence = attempt?.triggerOccurrenceId
      ? [...this.store.occurrences.values()].find(item => item.id === attempt.triggerOccurrenceId)
      : undefined;
    const context = composeContext({ agent, session, task, attempt, occurrence });
    const request = {
      invocationId: id("invoke"), sessionId: session.id, runId: run.id,
      prompt: task?.description ?? run.prompt, workdir: agent.config.workdir ?? process.cwd(), context,
      appendInstructions: renderPortableInstructions(context, perTurn),
      providerSession: session.providerSession, agentConfig: agent.config
    };
    run.invocationId = request.invocationId;
    for await (const event of this.host.invoke(agent.adapterType, request)) {
      this.store.appendEvent(envelope(run, run.nextSeq++, event));
      if (event.type === "session.update" && event.payload.providerSession) session.providerSession = event.payload.providerSession;
      if (isTerminal(event)) {
        run.status = event.type === "run.finished" ? "completed" : event.type === "run.stopped" ? "cancelled" : "failed";
        if (attempt) { attempt.status = run.status; task.status = run.status; delete task.activeRunId; }
        else delete session.activeRunId;
      }
      await this.store.commit();
    }
    return { task, attempt, run, events: this.store.events.get(run.id) };
  }

  async fire(triggerId, input) {
    const created = await this.materializeTrigger(triggerId, input);
    if (created.deduplicated) return created;
    const queued = await this.queueTask(created.task.id, { occurrenceId: created.occurrence.id, sourceType: created.occurrence.kind, sourceId: created.occurrence.externalEventId });
    return { ...created, result: await this.executeRun(queued.run.id) };
  }

  async continueTask(taskId, { sourceType = "comment", sourceId, instructions = "" } = {}) {
    const queued = await this.queueTask(taskId, { sourceType, sourceId });
    return this.executeRun(queued.run.id, instructions);
  }

  async sendChat(sessionId, prompt, instructions = "") {
    const queued = await this.queueChatTurn(sessionId, prompt);
    return this.executeRun(queued.run.id, instructions);
  }

  async terminalizeRun(runId, event) {
    if (!isTerminal(event)) throw new TypeError("terminal event required");
    const run = this.store.runs.get(runId);
    if (!run || ["completed", "failed", "cancelled"].includes(run.status)) return run;
    const attempt = run.attemptId ? this.store.attempts.get(run.attemptId) : undefined;
    const task = attempt ? this.store.tasks.get(attempt.taskId) : undefined;
    const session = this.store.sessions.get(run.sessionId);
    this.store.appendEvent(envelope(run, run.nextSeq++, event));
    run.status = event.type === "run.finished" ? "completed" : event.type === "run.stopped" ? "cancelled" : "failed";
    if (attempt) { attempt.status = run.status; task.status = run.status; delete task.activeRunId; }
    else delete session.activeRunId;
    await this.store.commit();
    return run;
  }

  async cancelRun(runId, reason = "cancelled") {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (["completed", "failed", "cancelled"].includes(run.status)) return { cancelled: false, status: run.status };
    if (run.status === "queued") {
      await this.terminalizeRun(runId, { type: "run.stopped", payload: { reason } });
      return { cancelled: true, status: "cancelled" };
    }
    const outcome = await this.host.cancel(run.invocationId, reason);
    return { cancelled: typeof outcome === "boolean" ? outcome : outcome?.cancelled === true, status: run.status };
  }
}
