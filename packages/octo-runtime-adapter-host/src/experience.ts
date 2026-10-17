import {
  canonicalTerminalStatus,
  isTerminal,
  type ActivityStartedPayload,
  type CanonicalEvent
} from "@mininglamp-oss/octo-runtime-protocol";

export class InvocationExperience {
  readonly #active = new Map<string, ActivityStartedPayload>();
  readonly #generations = new Map<string, number>();
  #terminal = false;

  start(): CanonicalEvent[] {
    return this.#begin("harness:starting", "starting", { type: "run" });
  }

  #begin(
    activityId: string,
    kind: ActivityStartedPayload["kind"],
    subject: ActivityStartedPayload["subject"]
  ): CanonicalEvent[] {
    if (this.#active.has(activityId)) return [];
    if (
      [...this.#active.values()].some(
        (active) =>
          active.source === "provider" &&
          active.kind === kind &&
          subjectKey(active.subject) === subjectKey(subject)
      )
    )
      return [];
    const generation = (this.#generations.get(activityId) ?? 0) + 1;
    this.#generations.set(activityId, generation);
    const payload: ActivityStartedPayload = {
      activityId: generation === 1 ? activityId : `${activityId}:${generation}`,
      kind,
      subject,
      source: "harness",
      info: {}
    };
    this.#active.set(activityId, payload);
    return [{ protocolVersion: 2, type: "activity.started", payload: { ...payload } }];
  }

  #finish(
    activityId: string,
    status: "completed" | "failed" | "cancelled" | "superseded" = "completed"
  ): CanonicalEvent[] {
    const active = this.#active.get(activityId);
    if (!active) return [];
    this.#active.delete(activityId);
    return [
      {
        protocolVersion: 2,
        type: "activity.finished",
        payload: { activityId: active.activityId, status }
      }
    ];
  }

  accept(event: CanonicalEvent): CanonicalEvent[] {
    if (this.#terminal) return [];
    const payload = event.payload;
    const messageProgress =
      event.type.startsWith("message.") &&
      ((typeof payload.text === "string" && payload.text.length > 0) ||
        (event.type === "message.create" && payload.channel === "analysis"));
    const progress =
      messageProgress ||
      event.type.startsWith("tool_call.") ||
      event.type.startsWith("model_step.") ||
      event.type === "interaction.requested" ||
      event.type === "activity.started" ||
      (event.type === "run.notice" && payload.code === "retry_scheduled");
    const output: CanonicalEvent[] = [];
    if (progress) {
      output.push(...this.#finish("harness:starting"));
      output.push(...this.#begin("harness:working", "working", { type: "run" }));
    }
    if (
      event.type.startsWith("message.") ||
      event.type.startsWith("tool_call.") ||
      event.type.startsWith("model_step.")
    ) {
      for (const [activityId, activity] of this.#active) {
        if (activity.kind === "retrying") output.push(...this.#finish(activityId));
      }
    }
    if (event.type === "run.notice" && payload.code === "retry_scheduled")
      output.push(...this.#begin(`retry:${event.payload.noticeId}`, "retrying", { type: "run" }));
    if (event.type === "activity.started") {
      for (const [id, active] of this.#active) {
        if (
          active.source === "harness" &&
          active.kind === event.payload.kind &&
          subjectKey(active.subject) === subjectKey(event.payload.subject)
        )
          output.push(...this.#finish(id, "superseded"));
      }
      this.#active.set(event.payload.activityId, { ...event.payload });
    }
    if (event.type === "activity.finished") this.#active.delete(event.payload.activityId);
    // A model round proves work, not reasoning. Only a reasoning message proves thinking.
    if (event.type === "tool_call.create") {
      for (const [id, active] of this.#active) {
        if (active.source === "harness" && active.subject.type === "message")
          output.push(...this.#finish(id, "superseded"));
      }
      output.push(
        ...this.#begin(`tool:${event.payload.id}`, "executing_tool", {
          type: "tool",
          id: String(payload.id)
        })
      );
    }
    if (event.type === "tool_call.update")
      output.push(
        ...this.#finish(`tool:${event.payload.id}`, canonicalTerminalStatus(payload.status))
      );
    if (event.type === "interaction.requested")
      output.push(
        ...this.#begin(
          `interaction:${event.payload.interactionId}`,
          payload.kind === "approval" ? "waiting_approval" : "waiting_input",
          { type: "interaction", id: String(payload.interactionId) }
        )
      );
    if (event.type === "interaction.resolved")
      output.push(
        ...this.#finish(
          `interaction:${String(payload.interactionId)}`,
          payload.status === "resolved" ? "completed" : "cancelled"
        )
      );
    if (event.type.startsWith("message.")) {
      const messageId = String(payload.messageId);
      const publicAnalysis = ["public_reasoning", "public_summary", "public_plan"].includes(
        String(payload.exposure)
      );
      const visible = payload.channel !== "analysis" || publicAnalysis;
      const closed =
        event.type === "message.update" &&
        ["completed", "failed", "cancelled", "canceled", "stopped"].includes(
          String(payload.status)
        );
      if (closed)
        output.push(
          ...this.#finish(`message:${messageId}`, canonicalTerminalStatus(payload.status))
        );
      else if (messageProgress) {
        for (const [id, active] of this.#active) {
          if (
            active.source === "harness" &&
            active.subject.type === "message" &&
            active.subject.id !== messageId
          )
            output.push(...this.#finish(id, "superseded"));
        }
        output.push(
          ...this.#begin(
            `message:${messageId}`,
            payload.channel === "analysis" ? "thinking" : "responding",
            { type: "message", id: messageId }
          )
        );
      }
      if (!visible) return output;
    }
    if (isTerminal(event)) {
      this.#terminal = true;
      const status =
        event.type === "run.completed"
          ? "completed"
          : event.type === "run.failed"
            ? "failed"
            : "cancelled";
      for (const activityId of this.#active.keys())
        output.push(...this.#finish(activityId, status));
      if (event.type === "run.completed")
        return [...output, { protocolVersion: 2, type: "run.completed", payload: {} }];
      if (event.type === "run.cancelled")
        return [
          ...output,
          { protocolVersion: 2, type: "run.cancelled", payload: { reasonCode: "cancelled" } }
        ];
      return [...output, event];
    }
    return [...output, event];
  }
}

function subjectKey(subject: ActivityStartedPayload["subject"]): string {
  return subject.type === "run" ? "run" : `${subject.type}:${subject.id}`;
}
