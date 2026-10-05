import { canonicalTerminalStatus, isTerminal, type ActivityStartedPayload, type CanonicalEvent } from "@mininglamp-oss/octo-harness-protocol";

export class InvocationExperience {
  readonly #active = new Map<string, ActivityStartedPayload>();

  start(): CanonicalEvent[] {
    return this.#begin("harness:starting", "starting", { type: "run" });
  }

  #begin(activityId: string, kind: ActivityStartedPayload["kind"], subject: ActivityStartedPayload["subject"]): CanonicalEvent[] {
    if (this.#active.has(activityId)) return [];
    const payload: ActivityStartedPayload = { activityId, kind, subject, source: "harness", info: {} };
    this.#active.set(activityId, payload);
    return [{ protocolVersion: 2, type: "activity.started", payload: { ...payload } }];
  }

  #finish(activityId: string, status: "completed" | "failed" | "cancelled" | "superseded" = "completed"): CanonicalEvent[] {
    if (!this.#active.delete(activityId)) return [];
    return [{ protocolVersion: 2, type: "activity.finished", payload: { activityId, status } }];
  }

  accept(event: CanonicalEvent): CanonicalEvent[] {
    const output = this.#finish("harness:starting");
    if (!isTerminal(event)) output.push(...this.#begin("harness:working", "working", { type: "run" }));
    const payload = event.payload;
    if (event.type === "activity.started") this.#active.set(event.payload.activityId, { ...event.payload });
    if (event.type === "activity.finished") this.#active.delete(event.payload.activityId);
    if (event.type === "model_step.started") output.push(...this.#begin(`step:${payload.stepId}`, "thinking", { type: "run" }));
    if (event.type === "model_step.finished") output.push(...this.#finish(`step:${payload.stepId}`, canonicalTerminalStatus(payload.status)));
    if (event.type === "tool_call.create") output.push(...this.#begin(`tool:${payload.id}`, "executing_tool", { type: "tool", id: String(payload.id) }));
    if (event.type === "tool_call.update") output.push(...this.#finish(`tool:${payload.id}`, canonicalTerminalStatus(payload.status)));
    if (event.type === "interaction.requested") output.push(...this.#begin(`interaction:${payload.interactionId}`, payload.kind === "approval" ? "waiting_approval" : "waiting_input", { type: "interaction", id: String(payload.interactionId) }));
    if (event.type.startsWith("message.")) {
      const messageId = String(payload.messageId);
      const publicAnalysis = ["public_reasoning", "public_summary", "public_plan"].includes(String(payload.exposure));
      const visible = payload.channel !== "analysis" || publicAnalysis;
      if (event.type !== "message.update") output.push(...this.#begin(`message:${messageId}`, payload.channel === "analysis" ? "thinking" : "responding", { type: "message", id: messageId }));
      else output.push(...this.#finish(`message:${messageId}`, payload.status === "failed" ? "failed" : payload.status === "cancelled" ? "cancelled" : "completed"));
      if (!visible) return output;
    }
    if (isTerminal(event)) {
      const status = event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "cancelled";
      for (const activityId of this.#active.keys()) output.push(...this.#finish(activityId, status));
      if (event.type === "run.completed") return [...output, { protocolVersion: 2, type: "run.completed", payload: {} }];
      if (event.type === "run.cancelled") return [...output, { protocolVersion: 2, type: "run.cancelled", payload: { reasonCode: "cancelled" } }];
      return [...output, { protocolVersion: 2, type: "run.failed", payload: { failure: payload.failure } }];
    }
    return [...output, event];
  }
}
