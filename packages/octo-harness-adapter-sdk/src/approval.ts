import { randomUUID } from "node:crypto";
import { sanitizePublicValue } from "./public-display.js";
import {
  contextHash,
  type CanonicalEvent,
  type InteractionResponse,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";

type RecordValue = Record<string, unknown>;
type Pending = {
  params: RecordValue;
  allow?: string;
  always?: string;
  decline?: string;
  expiresAt: number;
  timer: NodeJS.Timeout;
  resolve: (result: RecordValue) => void;
  reject: (error: Error) => void;
  written: Promise<void>;
  confirm: () => void;
  fail: (error: Error) => void;
  responding: boolean;
  automaticOutcome?: "accepted" | "cancelled";
};

export class AcpApprovalBridge {
  readonly #pending = new Map<string, Pending>();
  readonly #events: CanonicalEvent[] = [];
  #wake?: () => void;
  #error?: Error;
  #closed = false;
  #closeTransport?: () => Promise<void>;
  #transportClosed?: Promise<void>;
  readonly #abort = (): void => this.close("execution_lost");

  constructor(
    readonly request: InvokeRequest,
    readonly timeoutMs = 600_000,
    readonly options: { providerDecisions?: boolean; providerManagedExpiry?: boolean } = {}
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("APPROVAL_TIMEOUT_INVALID");
    request.signal?.addEventListener("abort", this.#abort, { once: true });
  }

  requestPermission(params: RecordValue, providerExpiresAt?: number): Promise<RecordValue> {
    if (this.#closed || this.request.signal?.aborted)
      return Promise.reject(new Error("APPROVAL_WAIT_UNAVAILABLE"));
    const options = Array.isArray(params.options) ? params.options.filter(isObject) : [];
    const option = (kind: string): string | undefined => {
      const candidate = options.find((value) => value.kind === kind);
      return typeof candidate?.optionId === "string" && candidate.optionId
        ? candidate.optionId
        : undefined;
    };
    const allow = option("allow_once");
    const always = this.options.providerDecisions ? option("allow_always") : undefined;
    const decline = option("reject_once");
    if (!allow && !always && !decline && this.request.approvalMode !== "full_access")
      return Promise.resolve(cancelled());
    if (this.#pending.size >= 16 || this.request.signal?.aborted)
      return Promise.reject(new Error("APPROVAL_WAIT_UNAVAILABLE"));
    const interactionId = `interaction_${randomUUID()}`;
    const now = Date.now();
    const expiresAt =
      providerExpiresAt === undefined
        ? now + this.timeoutMs
        : this.options.providerManagedExpiry
          ? providerExpiresAt
          : Math.min(now + this.timeoutMs, providerExpiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      return Promise.reject(new Error("APPROVAL_EXPIRED"));
    let confirm!: () => void;
    let fail!: (error: Error) => void;
    const written = new Promise<void>((resolve, reject) => {
      confirm = resolve;
      fail = reject;
    });
    void written.catch(() => undefined);
    const result = new Promise<RecordValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.options.providerManagedExpiry) {
          this.resolveFromProvider(params, "expired", undefined, "approval_timeout");
          return;
        }
        const error = new Error("APPROVAL_EXPIRED");
        this.#pending.delete(interactionId);
        reject(error);
        fail(error);
        this.#emit({
          protocolVersion: 2,
          type: "interaction.resolved",
          payload: {
            interactionId,
            executionInstanceId: this.request.invocationId,
            status: "expired",
            reasonCode: "approval_timeout"
          }
        });
        this.#error = error;
        this.#wake?.();
      }, expiresAt - now);
      timer.unref?.();
      this.#pending.set(interactionId, {
        params,
        allow,
        always,
        decline,
        expiresAt,
        timer,
        resolve,
        reject,
        written,
        confirm,
        fail,
        responding: this.request.approvalMode === "full_access",
        ...(this.request.approvalMode === "full_access"
          ? { automaticOutcome: allow ? "accepted" : "cancelled" }
          : {})
      });
    });
    const tool = isObject(params.toolCall)
      ? (sanitizePublicValue(params.toolCall) as RecordValue)
      : {};
    const input = isObject(tool.rawInput) ? tool.rawInput : {};
    const details = isObject(params.providerDetails)
      ? params.providerDetails
      : {
          ...(typeof input.command === "string" ? { command: input.command } : {}),
          ...(typeof input.file_path === "string" ? { files: [input.file_path] } : {}),
          ...(typeof tool.title === "string" ? { title: tool.title } : {})
        };
    this.#emit({
      protocolVersion: 2,
      type: "interaction.requested",
      payload: {
        interactionId,
        kind: "approval",
        executionInstanceId: this.request.invocationId,
        expiresAt: new Date(expiresAt).toISOString(),
        request: {
          schema: "octo.approval-request/v1",
          policy: { mode: this.request.approvalMode, hash: contextHash(this.request.context) },
          operation: {
            kind: "tool_execution",
            summary:
              typeof tool.title === "string" && tool.title
                ? Array.from(tool.title).slice(0, 500).join("")
                : "Approve tool execution",
            ...(typeof tool.toolCallId === "string" ? { toolCallId: tool.toolCallId } : {})
          },
          requestedPermissions: [],
          allowedOutcomes: [
            ...(allow || always ? ["accepted"] : []),
            ...(decline ? ["declined"] : []),
            "cancelled"
          ],
          grantScope: always ? "provider" : "request",
          ...(Object.keys(details).length
            ? {
                providerDetails: sanitizePublicValue(
                  Object.fromEntries(
                    Object.entries(details).filter(([, value]) => value !== undefined)
                  )
                )
              }
            : {})
        }
      }
    });
    if (this.request.approvalMode === "full_access")
      this.#pending.get(interactionId)!.resolve(allow ? selected(allow) : cancelled());
    return result;
  }

  async respond(response: InteractionResponse): Promise<void> {
    const pending = this.#pending.get(response.interactionId);
    if (
      !pending ||
      pending.responding ||
      pending.expiresAt <= Date.now() ||
      this.request.signal?.aborted
    )
      throw new Error("INTERACTION_NOT_ACTIVE");
    if (response.outcome === "answered") throw new Error("APPROVAL_RESPONSE_INVALID");
    let option =
      response.outcome === "accepted"
        ? pending.allow
        : response.outcome === "declined"
          ? pending.decline
          : undefined;
    if (response.value !== undefined) {
      if (
        !this.options.providerDecisions ||
        !isObject(response.value) ||
        Object.keys(response.value).length !== 1 ||
        typeof response.value.optionId !== "string"
      )
        throw new Error("APPROVAL_RESPONSE_INVALID");
      option = response.value.optionId;
      if (!(
        (response.outcome === "accepted" &&
          (option === pending.allow || option === pending.always)) ||
        (response.outcome === "declined" && option === pending.decline)
      ))
        throw new Error("APPROVAL_OUTCOME_UNSUPPORTED");
    }
    if (response.outcome !== "cancelled" && !option)
      throw new Error("APPROVAL_OUTCOME_UNSUPPORTED");
    pending.responding = true;
    pending.resolve(option ? selected(option) : cancelled());
    await pending.written;
    if (!this.#pending.has(response.interactionId) || this.#closed)
      throw new Error("INTERACTION_NOT_ACTIVE");
    clearTimeout(pending.timer);
    this.#pending.delete(response.interactionId);
    this.#emit({
      protocolVersion: 2,
      type: "interaction.resolved",
      payload: {
        interactionId: response.interactionId,
        executionInstanceId: this.request.invocationId,
        status: "resolved",
        outcome: response.outcome
      }
    });
  }

  responseWritten(params: RecordValue): void {
    for (const [interactionId, pending] of this.#pending) {
      if (pending.params !== params) continue;
      pending.confirm();
      if (pending.automaticOutcome) {
        clearTimeout(pending.timer);
        this.#pending.delete(interactionId);
        this.#emit({
          protocolVersion: 2,
          type: "interaction.resolved",
          payload: {
            interactionId,
            executionInstanceId: this.request.invocationId,
            status: "resolved",
            outcome: pending.automaticOutcome,
            reasonCode: "full_access_policy"
          }
        });
      }
    }
  }

  /** Provider expiry or a decision from another authorized surface is authoritative. */
  resolveFromProvider(
    params: RecordValue,
    status: "resolved" | "expired" | "invalidated",
    outcome?: "accepted" | "declined",
    reasonCode = "provider_resolved"
  ): void {
    for (const [interactionId, pending] of this.#pending) {
      if (pending.params !== params) continue;
      // Our own resolve broadcast can arrive before the RPC acknowledgement.
      if (pending.responding && status === "resolved") return;
      clearTimeout(pending.timer);
      this.#pending.delete(interactionId);
      pending.resolve({ providerResolved: true });
      pending.fail(new Error("INTERACTION_NOT_ACTIVE"));
      this.#emit({
        protocolVersion: 2,
        type: "interaction.resolved",
        payload: {
          interactionId,
          executionInstanceId: this.request.invocationId,
          status,
          ...(outcome ? { outcome } : {}),
          reasonCode
        }
      });
    }
  }

  responseFailed(params: RecordValue, error: Error): void {
    for (const pending of this.#pending.values())
      if (pending.params === params) pending.fail(error);
    this.#error = error;
    this.close("response_delivery_failed");
    this.#wake?.();
  }

  bindTransport(closeTransport: () => Promise<void>): void {
    if (this.#closeTransport) throw new Error("APPROVAL_TRANSPORT_ALREADY_BOUND");
    this.#closeTransport = closeTransport;
    if (this.#closed) this.#transportClosed = Promise.resolve().then(closeTransport);
    void this.#transportClosed?.catch(() => undefined);
  }

  async *stream(source: AsyncIterable<CanonicalEvent>): AsyncGenerator<CanonicalEvent> {
    const iterator = source[Symbol.asyncIterator]();
    let next = iterator.next();
    void next.catch(() => undefined);
    try {
      while (true) {
        while (this.#events.length) yield this.#events.shift()!;
        if (this.#error) throw this.#error;
        const wake = new Promise<{ wake: true }>((resolve) => {
          this.#wake = () => resolve({ wake: true });
        });
        const result = await Promise.race([next.then((value) => ({ value })), wake]);
        this.#wake = undefined;
        if ("wake" in result) continue;
        if (result.value.done) {
          this.close("execution_lost");
          while (this.#events.length) yield this.#events.shift()!;
          return;
        }
        if (["run.completed", "run.failed", "run.cancelled"].includes(result.value.value.type)) {
          this.close("run_terminal");
          while (this.#events.length) yield this.#events.shift()!;
        }
        yield result.value.value;
        next = iterator.next();
        void next.catch(() => undefined);
      }
    } catch (error) {
      this.close("execution_lost");
      while (this.#events.length) yield this.#events.shift()!;
      throw error;
    } finally {
      this.close("execution_lost");
      const cleanup = Promise.all([this.#transportClosed, iterator.return?.()]);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          cleanup,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("APPROVAL_CLEANUP_TIMEOUT")), 2_000);
          })
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  close(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#closeTransport) {
      this.#transportClosed = Promise.resolve().then(this.#closeTransport);
      void this.#transportClosed.catch(() => undefined);
    }
    this.request.signal?.removeEventListener("abort", this.#abort);
    for (const [interactionId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      const error = new Error("INTERACTION_NOT_ACTIVE");
      pending.reject(error);
      pending.fail(error);
      this.#emit({
        protocolVersion: 2,
        type: "interaction.resolved",
        payload: {
          interactionId,
          executionInstanceId: this.request.invocationId,
          status: "invalidated",
          reasonCode: reason
        }
      });
    }
    this.#pending.clear();
  }

  #emit(event: CanonicalEvent): void {
    this.#events.push(event);
    this.#wake?.();
  }
}

function selected(optionId: string): RecordValue {
  return { outcome: { outcome: "selected", optionId } };
}
function cancelled(): RecordValue {
  return { outcome: { outcome: "cancelled" } };
}
function isObject(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
