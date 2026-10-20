import { prepareInvokeInput } from "./invoke-input.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { sanitizePublicValue } from "@mininglamp-oss/octo-runtime-adapter-sdk";
export { prepareInvokeInput } from "./invoke-input.js";
export { resolveLocalContext, localRuntimeLimits } from "./context.js";
export {
  prepareRunContext,
  type PreparedRunContext,
  type WorkspaceAssignments
} from "./execution-preparation.js";
import type {
  AdapterInvocationContext,
  AdapterProbeOptions,
  AdapterOutput
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  createInputInvoke,
  assertInvokeRequestSize,
  type InvokeInput,
  type InvokeEnvironment,
  assertProtocolSupport,
  assertAdapterProtocolSupport,
  assertHostFrame,
  assertHostFrameIdentity,
  assertNativeInteractionResponse,
  resolveHostInvokeOptions,
  protocolError,
  type AdapterProtocolSupport,
  type HostInvokeOptions,
  type HostRunReceipt,
  type HostFrame,
  type HostControl,
  type NativeInteractionResponse,
  assertCanonicalEvent,
  assertInteractionResponse,
  assertInvokeRequest,
  failurePayload,
  isStreamCapacityReason,
  resolveStreamLimitPolicy,
  streamCapacityError,
  type StreamLimitPolicy,
  isTerminal,
  type CanonicalEvent,
  type InteractionResponse,
  type InvokeRequest,
  type MessageChannel,
  type MessageExposure,
  type MessageProvenance
} from "@mininglamp-oss/octo-runtime-protocol";
import { InvocationExperience } from "./experience.js";
import { withModelContexts } from "./model-input.js";
import { noopRuntimeLog, type RuntimeLog } from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { AdapterWatchdogTimeoutError, InvocationWatchdog } from "./watchdog.js";
export type {
  AdapterInvocationContext,
  AdapterOutput,
  AdapterProbeOptions,
  RuntimeLog
} from "@mininglamp-oss/octo-runtime-adapter-sdk";

/** Provider-neutral metadata the Host uses for registration and capability discovery. */
export interface HostedAdapterMetadata {
  /** False skips Runtime workspace preparation for this Provider. */
  workspace?: boolean;
  protocolSupport?: AdapterProtocolSupport;
  type: string;
  agentSources: ("preset" | "provisioned")[];
  processModel?: string;
  transport?: string;
  providerVersion?: string | null;
  providerPath?: string | null;
  available?: boolean;
  unavailableReason?: string | null;
}

/**
 * The minimal contract any Octo Runtime adapter must implement.
 * invoke may wrap a CLI subprocess, ACP, WebSocket or an in-process
 * implementation, as long as it emits a canonical event stream.
 */
export interface HostedAdapter {
  metadata: HostedAdapterMetadata;
  probe?: (options?: AdapterProbeOptions) => unknown;
  /** Execute a turn and report progress for host deadline enforcement. */
  invoke(request: InvokeRequest, context?: AdapterInvocationContext): AsyncIterable<AdapterOutput>;
  /** Resume a provider request that paused this exact active invocation. */
  respondInteraction?(invocationId: string, response: InteractionResponse): Promise<void>;
  respondNative?(invocationId: string, response: NativeInteractionResponse): Promise<void>;
}

interface MessageState {
  messageId: string;
  channel: MessageChannel;
  open: boolean;
  stepId?: string;
  exposure?: MessageExposure;
  provenance?: MessageProvenance;
}

export interface ExecutorShutdownResult {
  state: "closed";
  cleanup: "complete" | "incomplete";
  unresolvedInvocationIds: readonly string[];
  failedCleanupInvocationIds: readonly string[];
}

interface InvocationOwner {
  streamId: string;
  controller: AbortController;
  detach: () => void;
  close?: () => Promise<unknown>;
  cleanupAttempt?: Promise<unknown>;
  cleanupState?: "pending" | "failed";
}

/**
 * The in-process registry and lifecycle gatekeeper for adapters.
 * It validates plugin input/output, fills in the message lifecycle, guarantees
 * a single terminal, and turns cancellation into an AbortSignal.
 */
export class AgentExecutor {
  // F31：.octospec/tasks/gateway-august-feature-assessment/assessment.md
  readonly #log: RuntimeLog;
  constructor(options: { log?: RuntimeLog } = {}) {
    const log = options.log ?? noopRuntimeLog;
    this.#log = (level, event, data) => {
      try {
        log(level, event, data);
      } catch {
        /* 宿主诊断不影响执行。 */
      }
    };
  }
  readonly invoke = createInputInvoke((input, environment) =>
    this.invokeFrames(input, environment)
  );
  readonly #adapters = new Map<string, HostedAdapter>();
  readonly #active = new Map<string, AbortController>();
  readonly #activeAdapters = new Map<string, HostedAdapter>();
  readonly #owners = new Map<string, InvocationOwner>();
  #state: "open" | "closing" | "closed" = "open";
  #shutdownAttempt: Promise<ExecutorShutdownResult> | undefined;
  #shutdownResult: ExecutorShutdownResult | undefined;
  readonly #acceptedTerminals = new Set<string>();
  readonly #runs = new Map<
    string,
    {
      receipt: HostRunReceipt;
      at: number;
    }
  >();
  readonly #modes = new Map<string, "native" | "canonical">();
  /** Register an adapter by `metadata.type`; the same type cannot be overwritten twice. */
  register(adapter: HostedAdapter): void {
    this.#assertOpen();
    assertAdapterProtocolSupport(adapter.metadata.protocolSupport);
    if (this.#adapters.has(adapter.metadata.type))
      throw new Error(`duplicate adapter: ${adapter.metadata.type}`);
    this.#adapters.set(adapter.metadata.type, adapter);
  }

  /** List registered adapters, for Agent registration and control-plane display. */
  list(): HostedAdapterMetadata[] {
    return [...this.#adapters.values()].map((adapter) => ({
      ...adapter.metadata,
      protocolSupport: this.#support(adapter)
    }));
  }

  /** Report installed provider identity separately from adapter registration. */
  async describe(
    configurations: Record<string, AdapterProbeOptions> = {}
  ): Promise<HostedAdapterMetadata[]> {
    return Promise.all(
      [...this.#adapters.values()].map(async (adapter) => {
        let probe: Record<string, unknown> = {};
        let unavailableReason: string | null = adapter.probe ? "probe_invalid" : "probe_missing";
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result: unknown = await Promise.race([
            Promise.resolve().then(() => adapter.probe?.(configurations[adapter.metadata.type])),
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => {
                unavailableReason = "probe_timeout";
                resolve(undefined);
              }, 3_000);
            })
          ]);
          if (result && typeof result === "object") probe = result as Record<string, unknown>;
          if (probe.available === false)
            unavailableReason =
              typeof probe.reason === "string" ? probe.reason : "provider_unavailable";
        } catch {
          unavailableReason = "probe_failed";
          // A failed probe must not make the whole adapter host unavailable.
        } finally {
          if (timer) clearTimeout(timer);
        }
        const available =
          probe.available === true && typeof probe.command === "string" && probe.command.length > 0;
        return {
          ...adapter.metadata,
          protocolSupport: this.#support(adapter),
          available,
          unavailableReason: available ? null : unavailableReason,
          providerPath: available ? (probe.command as string) : null,
          providerVersion: typeof probe.version === "string" ? probe.version : null
        };
      })
    );
  }

  #support(adapter: HostedAdapter): AdapterProtocolSupport {
    const support = adapter.metadata.protocolSupport;
    assertAdapterProtocolSupport(support);
    return support;
  }

  /** Admission runs before RPC acknowledgement and never starts a provider. */
  #prepare(
    adapterType: string,
    request: InvokeRequest,
    options: HostInvokeOptions = {}
  ): HostRunReceipt {
    const resolved = resolveHostInvokeOptions(options);
    assertInvokeRequest(request);
    const registered = this.#adapters.get(adapterType);
    if (!registered) throw new Error(`unknown adapter: ${adapterType}`);
    const support = this.#support(registered);
    assertProtocolSupport(support, resolved);
    if (
      request.approvalMode !== "full_access" &&
      (resolved.protocolMode === "native"
        ? typeof registered.respondNative !== "function"
        : typeof registered.respondInteraction !== "function")
    ) {
      throw new Error(
        `APPROVAL_MODE_UNSUPPORTED: ${adapterType} does not implement execution-time approval responses`
      );
    }
    if (!registered?.metadata.agentSources.includes(request.agentSource))
      throw new Error("AGENT_SOURCE_UNSUPPORTED: " + adapterType);
    if (this.#runs.has(request.invocationId))
      throw protocolError(
        "EXECUTION_IDENTITY_CONFLICT",
        "EXECUTION_IDENTITY_CONFLICT: Invocation already executed"
      );
    for (const [id, run] of this.#runs) {
      if (!this.#owners.has(id) && !this.#modes.has(id) && Date.now() - run.at > 120_000)
        this.#runs.delete(id);
    }
    if (this.#runs.size >= 1024) throw new Error("RUN_CAPACITY_EXHAUSTED");
    if ([...this.#runs.values()].some((run) => run.receipt.run_id === request.runId))
      throw protocolError("EXECUTION_IDENTITY_CONFLICT");
    const receipt: HostRunReceipt = {
      run_id: request.runId,
      invocation_id: request.invocationId,
      stream_id: `host:${randomUUID()}`,
      agent_session_id: request.agentSessionId,
      session_generation: request.sessionGeneration ?? 0,
      protocol_mode: resolved.protocolMode,
      protocol: support.protocol
    };
    this.#runs.set(request.invocationId, {
      receipt,
      at: Date.now()
    });
    return { ...receipt };
  }

  /** Public invocations default to native; canonical consumers explicitly select their view. */
  invokeFrames(input: InvokeInput, environment: InvokeEnvironment = {}): AsyncGenerator<HostFrame> {
    const received = Date.now();
    try {
      const parts = Array.isArray(input?.inputs) ? input.inputs : [];
      const items = Array.isArray(input?.contexts?.items) ? input.contexts.items : [];
      this.#log("info", "invoke.received", {
        run_id: input?.runId,
        invocation_id: input?.invocationId,
        session_id: input?.sessionId,
        input_count: parts.length,
        text_input_count: parts.filter((part) => part?.type === "text").length,
        image_input_count: parts.filter((part) => part?.type === "image").length,
        context_count: items.filter(
          (item) => !(item?.namespace === "octo.execution" && item?.name === "adapter")
        ).length
      });
      environment.signal?.throwIfAborted();
      assertInvokeRequestSize(input, environment);
      const { adapterType, request, protocolMode } = prepareInvokeInput(input);
      request.signal = environment.signal;
      if (environment.executionEnvOverrides)
        request.executionEnvOverrides = structuredClone(environment.executionEnvOverrides);
      const streamLimits = resolveStreamLimitPolicy(environment.streamLimits);
      const { signal, ...wire } = request;
      const frozenRequest = withModelContexts({ ...structuredClone(wire), signal });
      return this.#admit(adapterType, frozenRequest, protocolMode, streamLimits, received);
    } catch (error) {
      this.#log("warn", "invoke.rejected", {
        code: errorCode(error) ?? "INVOKE_REJECTED",
        duration_ms: Date.now() - received
      });
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") throw new Error("EXECUTOR_CLOSED");
  }

  async *#admit(
    adapterType: string,
    request: InvokeRequest,
    protocolMode: "native" | "canonical",
    streamLimits: Readonly<StreamLimitPolicy>,
    received: number
  ): AsyncGenerator<HostFrame> {
    this.#assertOpen();
    request.signal?.throwIfAborted();
    const receipt = this.#prepare(adapterType, request, { protocolMode });
    const controller = new AbortController();
    const invocationId = request.invocationId;
    const signal = request.signal;
    const callerAbort = (): void => {
      if (!this.#acceptedTerminals.has(invocationId)) controller.abort(signal?.reason);
    };
    const owner: InvocationOwner = {
      streamId: receipt.stream_id,
      controller,
      detach: () => {
        signal?.removeEventListener("abort", callerAbort);
        controller.signal.removeEventListener("abort", onAbort);
      }
    };
    const onAbort = (): void => {
      void this.#cleanupOwner(invocationId, owner).catch(() => undefined);
    };
    this.#owners.set(request.invocationId, owner);
    this.#active.set(request.invocationId, controller);
    request.signal?.addEventListener("abort", callerAbort, { once: true });
    controller.signal.addEventListener("abort", onAbort, { once: true });
    this.#log("info", "invoke.accepted", {
      run_id: request.runId,
      invocation_id: request.invocationId,
      session_id: request.agentSessionId,
      adapter_type: adapterType,
      model: request.agentConfig?.model,
      duration_ms: Date.now() - received
    });
    yield* this.#streamInvocation(adapterType, request, receipt, streamLimits, owner);
  }

  #isCurrent(id: string, owner: InvocationOwner): boolean {
    return this.#runs.get(id)?.receipt.stream_id === owner.streamId;
  }

  #cleanupOwner(id: string, owner: InvocationOwner): Promise<unknown> {
    // A failed generator finalizer cannot be retried by calling return() again.
    if (owner.cleanupAttempt) return owner.cleanupAttempt;
    owner.cleanupState = "pending";
    owner.cleanupAttempt = Promise.resolve()
      .then(() => owner.close?.())
      .then(
        () => {
          if (this.#owners.get(id) === owner) this.#owners.delete(id);
          if (this.#isCurrent(id, owner)) {
            this.#active.delete(id);
            this.#activeAdapters.delete(id);
            if (owner.controller.signal.aborted) this.#modes.delete(id);
          }
        },
        (error: unknown) => {
          owner.cleanupState = "failed";
          throw error;
        }
      )
      .finally(() => {
        owner.detach();
        owner.detach = () => {};
      });
    return owner.cleanupAttempt;
  }

  async *#streamInvocation(
    adapterType: string,
    request: InvokeRequest,
    receipt: HostRunReceipt,
    streamLimits: Readonly<StreamLimitPolicy>,
    owner: InvocationOwner
  ): AsyncGenerator<HostFrame> {
    const started = Date.now();
    const identity = {
      run_id: request.runId,
      invocation_id: request.invocationId,
      session_id: request.agentSessionId,
      adapter_type: adapterType
    };
    this.#modes.set(request.invocationId, receipt.protocol_mode);
    let seq = 0;
    const frame = (output: AdapterOutput): HostFrame => {
      const result: HostFrame =
        "kind" in output
          ? ({ ...receipt, ...output, seq: seq + 1 } as HostFrame)
          : {
              ...receipt,
              protocol_mode: "canonical",
              kind: "canonical",
              event: output,
              seq: seq + 1
            };
      assertHostFrame(result);
      assertHostFrameIdentity(result, receipt);
      const size = Buffer.byteLength(JSON.stringify(result));
      if (size > streamLimits.hostFrameMaxBytes)
        throw streamCapacityError("HOST_FRAME_TOO_LARGE", {
          boundary: "adapter_host.frame",
          measuredBytes: size,
          limitBytes: streamLimits.hostFrameMaxBytes
        });
      seq++;
      return result;
    };
    let state: (HostControl & { type: "state" }) | undefined;
    let failureCode: string | undefined;
    const pendingInteractions = new Set<string | number>();
    const source =
      receipt.protocol_mode === "canonical"
        ? this.#invokeCanonical(adapterType, request, streamLimits, owner)
        : this.#invokeProvider(adapterType, request, "native", streamLimits, owner);
    try {
      yield frame({ kind: "control", control: { type: "state", state: "running" } });
      let pending = source.next();
      void pending.catch(() => undefined);
      while (true) {
        const next = await pending;
        if (next.done) break;
        const output = next.value;
        if (!("kind" in output) && output.type === "run.failed")
          failureCode = output.payload.failure?.code;
        if ("kind" in output && output.kind === "control" && output.control.type === "error")
          failureCode = output.control.code;
        if (
          "kind" in output &&
          output.kind === "control" &&
          output.control.type === "interaction"
        ) {
          if (output.control.status === "pending")
            pendingInteractions.add(output.control.requestId);
          else pendingInteractions.delete(output.control.requestId);
        }
        if (
          "kind" in output &&
          output.kind === "control" &&
          output.control.type === "state" &&
          output.control.state !== "running"
        )
          state = output.control;
        else if (!("kind" in output) && isTerminal(output)) {
          state = {
            type: "state",
            state:
              output.type === "run.completed"
                ? "completed"
                : output.type === "run.cancelled"
                  ? "cancelled"
                  : "failed"
          };
          // Canonical consumers may stop at the event instead of the Host state.
          await source.return(undefined);
          if (this.#isCurrent(request.invocationId, owner))
            this.#modes.delete(request.invocationId);
        }
        if (!(
          "kind" in output &&
          output.kind === "control" &&
          output.control.type === "state" &&
          output.control.state !== "running"
        ))
          yield frame(output);
        pending = source.next();
        void pending.catch(() => undefined);
      }
      if (!state) {
        yield frame({
          kind: "control",
          control: {
            type: "error",
            code: "HOST_ENDED_WITHOUT_TERMINAL",
            message: "Provider ended without terminal"
          }
        });
        state = { type: "state", state: "failed" };
      }
      for (const requestId of pendingInteractions)
        yield frame({
          kind: "control",
          control: { type: "interaction", requestId, status: "invalidated" }
        });
      pendingInteractions.clear();
      if (this.#isCurrent(request.invocationId, owner)) this.#modes.delete(request.invocationId);
      yield frame({ kind: "control", control: state });
    } catch (error) {
      owner.controller.abort(error);
      await source.return(undefined);
      state = { type: "state", state: "failed" };
      const causeCode = errorCode(error);
      const controlCode = isStreamCapacityReason(causeCode) ? causeCode : "HOST_FRAME_INVALID";
      failureCode = controlCode;
      const failure = isStreamCapacityReason(causeCode)
        ? failurePayload(
            { code: causeCode, ...capacityFailureDetails(error) },
            {
              stage: "adapter_host.frame",
              defaultDomain: "adapter",
              runId: request.runId,
              source: { component: "octo-runtime", adapter: adapterType }
            }
          ).failure
        : undefined;
      for (const requestId of pendingInteractions)
        yield {
          ...receipt,
          kind: "control",
          seq: ++seq,
          control: { type: "interaction", requestId, status: "invalidated" }
        };
      yield {
        ...receipt,
        kind: "control",
        seq: ++seq,
        control: {
          type: "error",
          code: controlCode,
          message: "Host output violated the selected stream contract",
          ...(failure ? { failure } : {})
        }
      };
      if (this.#isCurrent(request.invocationId, owner)) this.#modes.delete(request.invocationId);
      yield { ...receipt, kind: "control", seq: ++seq, control: state };
    } finally {
      try {
        if (this.#active.get(request.invocationId) === owner.controller)
          this.cancel(request.invocationId, "consumer_closed");
        await source.return(undefined);
      } finally {
        if (this.#isCurrent(request.invocationId, owner)) this.#modes.delete(request.invocationId);
        const cleanup = this.#cleanupOwner(request.invocationId, owner).catch(() => undefined);
        // Provider cleanup already used its grace budget; retain pending ownership
        // without adding a second shutdown-sized delay to stream completion.
        if (!owner.close) await cleanup;
        else void cleanup;
        const run = this.#runs.get(request.invocationId);
        if (run?.receipt.stream_id === owner.streamId) run.at = Date.now();
        if (state?.state === "failed")
          this.#log("error", "invoke.failed", {
            ...identity,
            code: failureCode ?? "EXECUTION_FAILED"
          });
        this.#log(state?.state === "failed" ? "error" : "info", "invoke.finished", {
          ...identity,
          frame_count: seq,
          status: state?.state ?? "unknown",
          duration_ms: Date.now() - started
        });
      }
    }
  }

  async *#invokeCanonical(
    adapterType: string,
    request: InvokeRequest,
    streamLimits: Readonly<StreamLimitPolicy>,
    owner: InvocationOwner
  ): AsyncGenerator<CanonicalEvent> {
    const experience = new InvocationExperience();
    const provider = this.#invokeProvider(adapterType, request, "canonical", streamLimits, owner);
    let pending = provider.next();
    void pending.catch(() => undefined);
    let finalBody = false;
    try {
      for (const event of experience.start()) yield event;
      while (true) {
        const next = await pending;
        if (next.done) break;
        const event = next.value;
        if ("kind" in event) throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
        if (
          event.type.startsWith("message.") &&
          event.payload.channel === "final" &&
          event.payload.text
        )
          finalBody = true;
        if (
          event.type === "run.completed" &&
          !finalBody &&
          typeof event.payload.text === "string" &&
          event.payload.text
        ) {
          const finalMessage: CanonicalEvent = {
            protocolVersion: 2,
            type: "message.update",
            payload: {
              messageId: `${request.runId}:final`,
              channel: "final",
              status: "completed",
              text: event.payload.text
            }
          };
          for (const projected of experience.accept(finalMessage)) yield projected;
        }
        for (const projected of experience.accept(event)) yield projected;
        pending = provider.next();
        void pending.catch(() => undefined);
      }
    } finally {
      await provider.return(undefined);
    }
  }

  async *#invokeProvider(
    adapterType: string,
    request: InvokeRequest,
    protocolMode: "native" | "canonical",
    streamLimits: Readonly<StreamLimitPolicy>,
    owner: InvocationOwner
  ): AsyncGenerator<AdapterOutput> {
    this.#log("info", "invoke.started", {
      run_id: request.runId,
      invocation_id: request.invocationId,
      session_id: request.agentSessionId,
      adapter_type: adapterType
    });
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    const controller = owner.controller;
    if (!controller.signal.aborted) this.#activeAdapters.set(request.invocationId, adapter);
    let terminal: CanonicalEvent | undefined;
    let nativeTerminal: (HostControl & { type: "state" }) | undefined;
    let outcome = "stopped";
    let conversions = 0;
    const identity = {
      run_id: request.runId,
      invocation_id: request.invocationId,
      session_id: request.agentSessionId,
      adapter_type: adapterType
    };
    const watchdog = new InvocationWatchdog(request.runtimeLimits, controller, (diagnostic) =>
      this.#log("warn", "invoke.watchdog", {
        ...identity,
        code: diagnostic.event
      })
    );
    let iterator: AsyncIterator<AdapterOutput> | undefined;
    let nextFailed = false;
    let iteratorDone = false;
    let cleanupWait: Promise<void> | undefined;
    let cleanupDeadline: number | undefined;
    const beginCleanup = (): number =>
      (cleanupDeadline ??= performance.now() + watchdog.limits.cancelGraceMs);
    const remainingCleanup = (): number => Math.max(0, beginCleanup() - performance.now());
    owner.close = async () => {
      if (!iterator) return;
      if (iterator.return) {
        const closed = await iterator.return();
        if (closed?.done !== true) throw new Error("EXECUTOR_CLEANUP_UNVERIFIED");
      } else if (!iteratorDone) throw new Error("EXECUTOR_CLEANUP_UNVERIFIED");
      // next() rejection can originate in finally; a later return() is not proof.
      if (nextFailed) throw new Error("EXECUTOR_CLEANUP_UNVERIFIED");
    };
    const readNext = async (source: AsyncIterator<AdapterOutput>) => {
      try {
        const result = await source.next();
        if (result.done) iteratorDone = true;
        return result;
      } catch (error) {
        nextFailed = true;
        throw error;
      }
    };
    const closeIterator = (): Promise<unknown> => {
      beginCleanup();
      return this.#cleanupOwner(request.invocationId, owner);
    };
    const waitCleanup = (): Promise<void> =>
      (cleanupWait ??= boundedCleanup(closeIterator(), remainingCleanup()));
    // The timer can fire while a consumer is paused at yield.
    const onAbort = () => {
      void waitCleanup().catch(() => undefined);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const messages = new Map<string, MessageState>();
    const anonymousMessages = new Map<string, string>();
    let messageNumber = 0;
    const context: AdapterInvocationContext = {
      protocolMode,
      streamLimits,
      reportConversion: () => {
        if (protocolMode === "native")
          throw protocolError(
            "EXECUTION_PROTOCOL_MISMATCH",
            "Native execution invoked a canonical converter"
          );
        conversions++;
      },
      reportActivity: (activity) => watchdog.activity(activity)
    };

    // A provider may emit only deltas; here the host fills in the message lifecycle and stabilizes the messageId.
    const prepareMessage = (
      event: CanonicalEvent
    ): { prefix: CanonicalEvent[]; event: CanonicalEvent } => {
      const isMessage =
        event.type === "message.create" ||
        event.type === "message.delta" ||
        event.type === "message.update";
      if (!isMessage) return { prefix: [], event };
      const previous = event.payload.messageId ? messages.get(event.payload.messageId) : undefined;
      const channel = event.payload.channel ?? previous?.channel ?? "final";
      const segmentKey = `${channel}:${event.payload.stepId ?? ""}`;
      const currentAnonymous = anonymousMessages.get(segmentKey);
      const messageId =
        event.payload.messageId ??
        (currentAnonymous && messages.get(currentAnonymous)?.open && event.type !== "message.create"
          ? currentAnonymous
          : `${request.runId}:${channel}:message:${++messageNumber}`);
      if (!event.payload.messageId) anonymousMessages.set(segmentKey, messageId);
      const state = messages.get(messageId);
      const stepId =
        typeof event.payload.stepId === "string" ? event.payload.stepId : state?.stepId;
      const analysisMetadata =
        channel === "analysis"
          ? {
              exposure: event.payload.exposure ?? "unknown",
              provenance: event.payload.provenance ?? {
                provider: adapterType,
                nativeEvent: "unknown"
              }
            }
          : {};
      const prepared: CanonicalEvent = {
        ...event,
        payload: { ...event.payload, channel, messageId, ...analysisMetadata }
      };
      const prefix: CanonicalEvent[] =
        !state && event.type !== "message.create"
          ? [
              {
                protocolVersion: 2,
                type: "message.create",
                payload: {
                  role: "assistant",
                  status: "streaming",
                  channel,
                  messageId,
                  ...(stepId ? { stepId } : {}),
                  ...analysisMetadata
                }
              }
            ]
          : [];
      const closed =
        event.type === "message.update" &&
        ["completed", "failed", "cancelled", "canceled", "stopped"].includes(
          String(event.payload.status)
        );
      messages.set(messageId, {
        messageId,
        channel,
        open: !closed,
        ...(stepId ? { stepId } : {}),
        ...analysisMetadata
      });
      return { prefix, event: prepared };
    };

    const closeMessages = (
      status: string,
      stepId?: string,
      onlyAnonymous = false
    ): CanonicalEvent[] => {
      const closed: CanonicalEvent[] = [];
      for (const state of messages.values()) {
        if (!state.open || (stepId !== undefined && state.stepId !== stepId)) continue;
        if (onlyAnonymous && ![...anonymousMessages.values()].includes(state.messageId)) continue;
        state.open = false;
        closed.push({
          protocolVersion: 2,
          type: "message.update",
          payload: {
            role: "assistant",
            status,
            channel: state.channel,
            messageId: state.messageId,
            ...(state.stepId ? { stepId: state.stepId } : {}),
            ...(state.exposure ? { exposure: state.exposure } : {}),
            ...(state.provenance ? { provenance: state.provenance } : {})
          }
        });
      }
      return closed;
    };

    try {
      controller.signal.throwIfAborted();
      const invocation = adapter.invoke({ ...request, signal: controller.signal }, context);
      iterator = invocation[Symbol.asyncIterator]();
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const pendingNext = readNext(iterator);
        const next =
          terminal || nativeTerminal
            ? await withCleanupDeadline(
                pendingNext,
                beginCleanup(),
                watchdog.limits.cancelGraceMs,
                controller
              )
            : await waitForNext(pendingNext, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (next.done) break;
        const adapterEvent = next.value;
        if (protocolMode === "native") {
          if (!("kind" in adapterEvent)) throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
          if (nativeTerminal) throw new Error(`${adapterType} emitted after terminal`);
          if (adapterEvent.kind === "control" && adapterEvent.control.type === "interaction")
            watchdog.interaction(
              adapterEvent.control.requestId,
              adapterEvent.control.status === "pending"
            );
          if (
            adapterEvent.kind === "control" &&
            adapterEvent.control.type === "state" &&
            adapterEvent.control.state !== "running"
          ) {
            nativeTerminal = adapterEvent.control;
            beginCleanup();
            watchdog.terminal();
            this.#acceptedTerminals.add(request.invocationId);
          } else yield adapterEvent;
          continue;
        }
        assertCanonicalEvent(adapterEvent);
        const event: CanonicalEvent =
          adapterEvent.type === "run.failed"
            ? {
                protocolVersion: 2,
                type: "run.failed",
                payload: await adapterFailurePayload(adapterEvent.payload, request.workdir, {
                  stage: "provider.invoke",
                  defaultDomain: "provider",
                  runId: request.runId,
                  source: { component: "octo-runtime", adapter: adapterType }
                })
              }
            : adapterEvent;
        watchdog.canonical(event);
        if (terminal) throw new Error(`${adapterType} emitted after terminal event`);
        if (isTerminal(event)) {
          terminal = event;
          beginCleanup();
          // A later user cancellation cannot replace an accepted provider terminal.
          this.#acceptedTerminals.add(request.invocationId);
        } else {
          // Placeholder creates do not establish a provider message boundary.
          if (event.type === "message.create" && !event.payload.messageId && !event.payload.text)
            continue;
          if (
            event.type === "message.update" &&
            !event.payload.messageId &&
            !event.payload.text &&
            ["completed", "failed", "cancelled", "canceled", "stopped"].includes(
              String(event.payload.status)
            )
          ) {
            for (const closed of closeMessages(
              String(event.payload.status),
              typeof event.payload.stepId === "string" ? event.payload.stepId : undefined
            ))
              yield closed;
            continue;
          }
          if (event.type === "tool_call.create") {
            for (const closed of closeMessages("completed", undefined, true)) yield closed;
            anonymousMessages.clear();
          }
          if (event.type === "model_step.finished") {
            for (const closed of closeMessages(event.payload.status, event.payload.stepId))
              yield closed;
          }
          const prepared = prepareMessage(event);
          for (const prefix of prepared.prefix) yield prefix;
          yield prepared.event;
        }
      }
      await withCleanupDeadline(
        closeIterator(),
        beginCleanup(),
        watchdog.limits.cancelGraceMs,
        controller
      );
      if (protocolMode === "native") {
        if (!nativeTerminal) throw protocolError("HOST_ENDED_WITHOUT_TERMINAL");
        outcome = nativeTerminal.state;
        yield { kind: "control", control: nativeTerminal };
        return;
      }
      if (!terminal) throw protocolError("HOST_ENDED_WITHOUT_TERMINAL");
      const messageStatus =
        terminal.type === "run.completed"
          ? "completed"
          : terminal.type === "run.failed"
            ? "failed"
            : "cancelled";
      outcome = messageStatus;
      for (const event of closeMessages(messageStatus)) yield event;
      yield terminal;
    } catch (caught) {
      const error =
        controller.signal.reason instanceof AdapterWatchdogTimeoutError
          ? controller.signal.reason
          : caught;
      const failure = await adapterFailurePayload(
        {
          message: errorMessage(error),
          adapterType,
          ...(errorCode(error) ? { code: errorCode(error) } : {}),
          ...capacityFailureDetails(error),
          ...watchdogFailureDetails(error)
        },
        request.workdir,
        {
          stage: "adapter.invoke",
          defaultDomain: "adapter",
          runId: request.runId,
          source: { component: "octo-runtime", adapter: adapterType }
        }
      );
      const userCancelled =
        controller.signal.aborted &&
        !(controller.signal.reason instanceof AdapterWatchdogTimeoutError);
      outcome = userCancelled ? "stopped" : "failed";
      if (
        error instanceof AdapterWatchdogTimeoutError &&
        error.timeoutReason === "cleanup_timeout"
      ) {
        try {
          this.#log("warn", "invoke.watchdog", {
            ...identity,
            code: "ADAPTER_CLEANUP_TIMEOUT"
          });
        } catch {
          /* best effort */
        }
      }
      watchdog.dispose();
      if (!controller.signal.aborted) controller.abort(error);
      await waitCleanup().catch(() => undefined);
      if (protocolMode === "native") {
        const nativeFailureCode = errorCode(error);
        if (!userCancelled)
          yield {
            kind: "control",
            control: {
              type: "error",
              code:
                nativeFailureCode === "HOST_ENDED_WITHOUT_TERMINAL"
                  ? "HOST_ENDED_WITHOUT_TERMINAL"
                  : isStreamCapacityReason(nativeFailureCode)
                    ? nativeFailureCode
                    : "HOST_EXECUTION_FAILED",
              message: String(failure.message),
              ...(isStreamCapacityReason(nativeFailureCode) ? { failure: failure.failure } : {})
            }
          };
        yield {
          kind: "control",
          control: { type: "state", state: userCancelled ? "cancelled" : "failed" }
        };
        return;
      }
      for (const event of closeMessages(userCancelled ? "cancelled" : "failed")) yield event;
      if (userCancelled) {
        yield {
          protocolVersion: 2,
          type: "run.cancelled",
          payload: { reason: String(controller.signal.reason ?? "cancelled") }
        };
      } else if (terminal?.type === "run.failed") {
        yield terminal;
      } else {
        yield {
          protocolVersion: 2,
          type: "run.failed",
          payload: failure
        };
      }
    } finally {
      watchdog.finish(outcome);
      this.#log("info", "invoke.conversion", {
        run_id: request.runId,
        invocation_id: request.invocationId,
        protocol_mode: protocolMode,
        conversion_count: conversions
      });
      if (!terminal && !nativeTerminal && !controller.signal.aborted)
        controller.abort("consumer closed");
      await waitCleanup().catch(() => undefined);
      controller.signal.removeEventListener("abort", onAbort);
      if (this.#isCurrent(request.invocationId, owner)) {
        this.#active.delete(request.invocationId);
        this.#activeAdapters.delete(request.invocationId);
        this.#acceptedTerminals.delete(request.invocationId);
      }
    }
  }

  /** Run the adapter's own environment probe; return an unchecked-available status when there is no probe. */
  probe(adapterType: string, options?: AdapterProbeOptions): unknown {
    const adapter = this.#adapters.get(adapterType);
    if (!adapter) throw new Error(`unknown adapter: ${adapterType}`);
    if (!adapter.probe) return { available: true, adapterType, unchecked: true };
    return adapter.probe(options);
  }

  /** Abort an active invocation; returns false when that invocation no longer exists or has already ended. */
  cancel(invocationId: string, reason = "cancelled"): boolean {
    const controller = this.#active.get(invocationId);
    if (!controller || controller.signal.aborted || this.#acceptedTerminals.has(invocationId))
      return false;
    this.#log("info", "invoke.cancel_requested", { invocation_id: invocationId });
    controller.abort(reason);
    this.#log("info", "invoke.cancel_accepted", { invocation_id: invocationId });
    return true;
  }

  /** Route an answer only to the adapter instance that owns the active invocation. */
  async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
    assertInteractionResponse(response);
    const adapter = this.#activeAdapters.get(invocationId);
    if (!adapter || this.#acceptedTerminals.has(invocationId)) {
      throw new Error(`invocation is not active: ${invocationId}`);
    }
    if (this.#modes.get(invocationId) !== "canonical")
      throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
    if (!adapter.respondInteraction) {
      throw new Error(`adapter does not support interaction responses: ${adapter.metadata.type}`);
    }
    await adapter.respondInteraction(invocationId, response);
  }

  async respondNative(invocationId: string, response: NativeInteractionResponse): Promise<void> {
    assertNativeInteractionResponse(response);
    if (this.#modes.get(invocationId) !== "native")
      throw protocolError("EXECUTION_PROTOCOL_MISMATCH");
    const adapter = this.#activeAdapters.get(invocationId);
    if (!adapter?.respondNative || this.#acceptedTerminals.has(invocationId))
      throw protocolError("INTERACTION_NOT_ACTIVE");
    await adapter.respondNative(invocationId, response);
  }

  /** Abort every invocation and wait briefly for adapter cleanup to reap its
   * provider processes. Used when the RPC parent disappears or shuts down. */
  shutdown(reason = "executor shutdown", timeoutMs = 2_500): Promise<ExecutorShutdownResult> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("shutdown timeoutMs must be a positive safe integer");
    if (this.#shutdownAttempt) return this.#shutdownAttempt;
    if (this.#shutdownResult?.cleanup === "complete") return Promise.resolve(this.#shutdownResult);
    this.#state = "closing";
    const pending: Promise<unknown>[] = [];
    for (const [id, owner] of this.#owners) {
      if (!this.#acceptedTerminals.has(id)) owner.controller.abort(reason);
      pending.push(this.#cleanupOwner(id, owner));
    }
    this.#shutdownAttempt = boundedCleanup(Promise.allSettled(pending), timeoutMs).then(() => {
      this.#state = "closed";
      const unresolvedInvocationIds = Object.freeze([...this.#owners.keys()]);
      const failedCleanupInvocationIds = Object.freeze(
        [...this.#owners].filter(([, owner]) => owner.cleanupState === "failed").map(([id]) => id)
      );
      const result: ExecutorShutdownResult = Object.freeze({
        state: "closed",
        cleanup: unresolvedInvocationIds.length ? "incomplete" : "complete",
        unresolvedInvocationIds,
        failedCleanupInvocationIds
      });
      this.#shutdownResult = result;
      this.#shutdownAttempt = undefined;
      return result;
    });
    return this.#shutdownAttempt;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Keep the Adapter's failure detail; catalog normalization only adds classification. */
async function adapterFailurePayload(
  input: Record<string, unknown>,
  workdir: string,
  context: Parameters<typeof failurePayload>[1]
): Promise<ReturnType<typeof failurePayload>> {
  let detail = input;
  // Node reports the same spawn errno for a missing command and a missing cwd.
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(String(input.code)) && workdir) {
    let problem: string | undefined;
    try {
      if (!(await stat(workdir)).isDirectory()) problem = "配置的工作目录不是文件夹";
      else await access(workdir, constants.X_OK);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") problem = "配置的工作目录不存在";
      else if (code === "ENOTDIR") problem = "配置的工作目录路径中包含非文件夹项";
      else if (code === "EACCES" || code === "EPERM") problem = "没有进入配置工作目录的权限";
    }
    if (problem)
      detail = {
        ...input,
        code: "ADAPTER_INVOCATION_FAILED",
        message: `${problem}（adapter.workdir=${workdir}）。${typeof input.message === "string" ? input.message : ""}`,
        error: input.error ?? { code: input.code, message: input.message }
      };
  }
  const normalized = failurePayload(detail, {
    ...context,
    ...(detail !== input ? { defaultDomain: "adapter" as const } : {})
  });
  const safe = sanitizePublicValue(detail) as Record<string, unknown>;
  const message =
    typeof safe.message === "string" && safe.message.trim()
      ? safe.message
      : typeof safe.error === "string"
        ? safe.error
        : safe.error && typeof safe.error === "object"
          ? JSON.stringify(safe.error, null, 2)
          : normalized.message;
  return {
    ...safe,
    ...normalized,
    message
  };
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function capacityFailureDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const input = error as Record<string, unknown>;
  return Object.fromEntries(
    ["boundary", "measuredBytes", "limitBytes", "itemCount", "limitItems"]
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key]])
  );
}

async function waitForNext<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error(String(signal.reason ?? "cancelled"))
          );
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function boundedCleanup(cleanup: Promise<unknown>, graceMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withCleanupDeadline<T>(
  pending: Promise<T>,
  deadline: number,
  graceMs: number,
  controller: AbortController
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => {
            const error = new AdapterWatchdogTimeoutError("cleanup", graceMs, "cleanup_timeout");
            reject(error);
            controller.abort(error);
          },
          Math.max(0, deadline - performance.now())
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function watchdogFailureDetails(error: unknown): Record<string, unknown> {
  return error instanceof AdapterWatchdogTimeoutError
    ? {
        timeoutStage: error.timeoutStage,
        timeoutMs: error.timeoutMs,
        timeoutReason: error.timeoutReason,
        watchdog: error.evidence
      }
    : {};
}

export { DEFAULT_RUNTIME_LIMITS } from "./watchdog.js";
