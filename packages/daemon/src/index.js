import { EventEmitter } from "node:events";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export class HarnessDaemon extends EventEmitter {
  #engine;
  #store;
  #pending = new Map();
  #waiters = new Map();
  #timers = new Map();

  constructor({ engine, store }) { super(); this.#engine = engine; this.#store = store; }

  async recover() {
    for (const run of this.#store.runs.values()) {
      if (run.status === "running") {
        await this.#engine.terminalizeRun(run.id, { type: "run.error", payload: { code: "daemon_restarted", message: "daemon restarted while provider was active" } });
      } else if (run.status === "queued") this.#schedule(run.id);
    }
    for (const task of this.#store.tasks.values()) {
      if (task.status !== "queued" || task.activeRunId) continue;
      const occurrence = [...this.#store.occurrences.values()].find(item => item.taskId === task.id);
      const queued = await this.#engine.queueTask(task.id, {
        occurrenceId: occurrence?.id, sourceType: occurrence?.kind ?? "recovery", sourceId: occurrence?.externalEventId
      });
      this.#schedule(queued.run.id);
    }
    this.startSchedulers();
  }

  startSchedulers() {
    for (const trigger of this.#store.triggers.values()) {
      if (!trigger.enabled || trigger.kind !== "interval" || this.#timers.has(trigger.id)) continue;
      const timer = setInterval(() => {
        const bucket = Math.floor(Date.now() / trigger.everyMs);
        this.submitTrigger(trigger.id, { externalEventId: `interval:${bucket}`, payload: { scheduledAt: bucket * trigger.everyMs } })
          .catch(error => this.emit("scheduler.error", { triggerId: trigger.id, error }));
      }, trigger.everyMs);
      this.#timers.set(trigger.id, timer);
    }
  }

  stop() { for (const timer of this.#timers.values()) clearInterval(timer); this.#timers.clear(); }

  async ingestEvent({ eventType, externalEventId, payload = {} }) {
    if (!eventType || !externalEventId) throw new Error("eventType and externalEventId are required");
    const matched = [...this.#store.triggers.values()].filter(trigger =>
      trigger.enabled && trigger.kind === "event" && trigger.eventType === eventType && matchesFilter(payload, trigger.filter)
    );
    return Promise.all(matched.map(trigger => this.submitTrigger(trigger.id, { externalEventId, payload })));
  }

  async submitTrigger(triggerId, input) {
    const created = await this.#engine.materializeTrigger(triggerId, input);
    if (created.deduplicated) {
      const run = [...this.#store.runs.values()].find(item => this.#store.attempts.get(item.attemptId)?.taskId === created.task.id);
      return { accepted: false, deduplicated: true, taskId: created.task.id, runId: run?.id };
    }
    const queued = await this.#engine.queueTask(created.task.id, {
      occurrenceId: created.occurrence.id, sourceType: created.occurrence.kind, sourceId: created.occurrence.externalEventId
    });
    this.#schedule(queued.run.id);
    return { accepted: true, deduplicated: false, taskId: created.task.id, runId: queued.run.id };
  }

  async continueTask(taskId, input = {}) {
    const queued = await this.#engine.queueTask(taskId, input);
    this.#schedule(queued.run.id, input.instructions ?? "");
    return { accepted: true, taskId, runId: queued.run.id };
  }

  async submitChat(sessionId, prompt, instructions = "") {
    const queued = await this.#engine.queueChatTurn(sessionId, prompt);
    this.#schedule(queued.run.id, instructions);
    return { accepted: true, sessionId, runId: queued.run.id };
  }

  #schedule(runId, instructions = "") {
    if (this.#pending.has(runId)) return;
    const job = new Promise(resolve => setImmediate(resolve))
      .then(() => this.#engine.executeRun(runId, instructions))
      .catch(async error => {
        await this.#engine.terminalizeRun(runId, { type: "run.error", payload: { code: "daemon_execution_error", message: error.message } });
        return { run: this.#store.runs.get(runId), error };
      })
      .then(result => {
        this.emit("run.terminal", { runId, status: this.#store.runs.get(runId)?.status });
        for (const resolve of this.#waiters.get(runId) ?? []) resolve(result);
        this.#waiters.delete(runId);
        return result;
      })
      .finally(() => this.#pending.delete(runId));
    this.#pending.set(runId, job);
  }

  async waitForRun(runId) {
    const run = this.#store.runs.get(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (TERMINAL.has(run.status)) return { run, events: this.#store.events.get(runId) ?? [] };
    return new Promise(resolve => {
      const waiters = this.#waiters.get(runId) ?? [];
      waiters.push(resolve); this.#waiters.set(runId, waiters);
    });
  }

  cancelRun(runId, reason) { return this.#engine.cancelRun(runId, reason); }
}

function matchesFilter(payload, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, expected]) => payload?.[key] === expected);
}
