import {
  canonicalTerminalStatus,
  type CanonicalEvent
} from "@mininglamp-oss/octo-harness-protocol";
import { acpToolTerminalStatus } from "./acp-tool.js";

const MAX_STEP_PUBLIC_TEXT_CHARS = 1_000;

/**
 * ACP standardizes the stream envelope but does not require providers to emit
 * public thought chunks or model-round boundaries. Reconstruct conservative
 * round boundaries from tool lifecycles and retain only already-public answer
 * text as the card fallback when a provider exposes no reasoning.
 */
export class AcpTurnNormalizer {
  readonly #provider: string;
  readonly #activeTools = new Set<string>();
  readonly #seenTools = new Set<string>();
  #stepNumber = 0;
  #stepId?: string;
  #stepHasTool = false;
  #stepPublicText = "";
  #toolsCompleted = false;
  #message?: CanonicalEvent["payload"];
  readonly #segments = new Map<string, number>();

  constructor(provider: string) {
    this.#provider = provider;
  }

  normalize(nativeType: unknown, normalized: CanonicalEvent[]): CanonicalEvent[] {
    const semantic = normalized.some(
      (event) => event.type.startsWith("message.") || event.type.startsWith("tool_call.")
    );
    if (!semantic) return normalized;

    const startsModelOutput =
      nativeType === "agent_message_chunk" ||
      nativeType === "agent_thought_chunk" ||
      nativeType === "tool_call";
    const events: CanonicalEvent[] = [];
    if (startsModelOutput && this.#toolsCompleted)
      events.push(...this.#finishStep("tool-calls", "completed"));
    events.push(...this.#ensureStep());

    const stepId = this.#stepId;
    for (const event of normalized) {
      if (event.type === "message.delta") {
        const channel = event.payload.channel ?? "final";
        if (this.#message && this.#message.channel !== channel)
          events.push(...this.#closeMessage());
        if (!this.#message) {
          const base = `${stepId}:${channel === "analysis" ? "reasoning" : "answer"}`;
          const count = (this.#segments.get(base) ?? 0) + 1;
          this.#segments.set(base, count);
          this.#message = {
            ...event.payload,
            stepId,
            channel,
            messageId: count === 1 ? base : `${base}:${count}`
          };
        }
        events.push({
          ...event,
          payload: {
            ...event.payload,
            ...(stepId ? { stepId } : {}),
            messageId: this.#message.messageId
          }
        });
        if (event.payload.channel !== "analysis") this.#appendPublicText(event.payload.text);
        continue;
      }
      const toolId = typeof event.payload.id === "string" ? event.payload.id : undefined;
      if (event.type === "tool_call.create" && toolId) {
        if (this.#seenTools.has(toolId)) continue;
        this.#seenTools.add(toolId);
        events.push(...this.#closeMessage());
        events.push({ ...event, payload: { ...event.payload, ...(stepId ? { stepId } : {}) } });
        this.#activeTools.add(toolId);
        this.#stepHasTool = true;
        this.#toolsCompleted = false;
        continue;
      }
      if (
        event.type === "tool_call.update" &&
        toolId &&
        acpToolTerminalStatus(event.payload.status) !== undefined
      ) {
        this.#seenTools.add(toolId);
        this.#stepHasTool = true;
        events.push(...this.#closeMessage());
        events.push({ ...event, payload: { ...event.payload, ...(stepId ? { stepId } : {}) } });
        this.#activeTools.delete(toolId);
        if (this.#stepHasTool && this.#activeTools.size === 0) this.#toolsCompleted = true;
        continue;
      }
      if (event.type === "tool_call.update") {
        events.push({ ...event, payload: { ...event.payload, ...(stepId ? { stepId } : {}) } });
        continue;
      }
      events.push(event);
    }
    return events;
  }

  finish(finishReason: string | undefined, status: string): CanonicalEvent[] {
    const reason =
      this.#stepHasTool && this.#stepPublicText.length === 0
        ? "tool-calls"
        : (finishReason ?? "end_turn");
    return this.#finishStep(reason, status);
  }

  #ensureStep(): CanonicalEvent[] {
    if (this.#stepId) return [];
    this.#stepId = `${this.#provider}:step:${++this.#stepNumber}`;
    return [{ protocolVersion: 2, type: "model_step.started", payload: { stepId: this.#stepId } }];
  }

  #finishStep(finishReason: string, status: string): CanonicalEvent[] {
    if (!this.#stepId) return [];
    const closed = this.#closeMessage(status);
    const event: CanonicalEvent = {
      protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: this.#stepId,
        status: canonicalTerminalStatus(status),
        finishReason
      }
    };
    this.#stepId = undefined;
    this.#stepHasTool = false;
    this.#stepPublicText = "";
    this.#toolsCompleted = false;
    return [...closed, event];
  }

  #closeMessage(status = "completed"): CanonicalEvent[] {
    if (!this.#message) return [];
    const payload = { ...this.#message };
    delete payload.text;
    this.#message = undefined;
    return [
      {
        protocolVersion: 2,
        type: "message.update",
        payload: { ...payload, status: canonicalTerminalStatus(status) }
      }
    ];
  }

  #appendPublicText(value: unknown): void {
    if (typeof value !== "string" || !value) return;
    const remaining = MAX_STEP_PUBLIC_TEXT_CHARS - Array.from(this.#stepPublicText).length;
    if (remaining <= 0) return;
    this.#stepPublicText += Array.from(value).slice(0, remaining).join("");
  }
}
