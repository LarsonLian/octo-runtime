import {
  createInputInvoke,
  canonicalEvents,
  isHostTerminal,
  identifyInvokeInput,
  assertHostRunReceipt,
  type HostFrame,
  type HostRunReceipt,
  type InvokeInput,
  type InvokeEnvironment
} from "@mininglamp-oss/octo-runtime-protocol";
import {
  RuntimeLogging,
  type RuntimeLoggingOptions
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  ExtraPlugins,
  type ExtraAdapterHost,
  type ExtraContext,
  type ExtraPluginModule,
  type JsonObject
} from "../extras.js";
import { invokeDaemonRun } from "./run-stream.js";
import { callDaemon } from "./runtime-contract.js";

interface ActiveInvocation {
  invocationId: string;
  runId: string;
  controller: AbortController;
  source: AsyncGenerator<HostFrame>;
  accepted: boolean;
  cancelForDisposal(): Promise<void>;
  finished: Promise<void>;
}

/** .octospec/tasks/sdk-host-extra-contexts/flows.md：SDK 持有装配与执行桥，宿主只传业务依赖。 */
export class LocalExtras {
  readonly plugins: ExtraPlugins;
  readonly #logs: RuntimeLogging;
  readonly #invocations = new Map<string, ActiveInvocation>();
  readonly #runs = new Set<string>();
  #closing?: Promise<void>;

  constructor(
    private readonly socket: string,
    private readonly isActive: () => boolean,
    logging?: RuntimeLoggingOptions
  ) {
    this.#logs = new RuntimeLogging(logging);
    // 容器的基础端口不交给业务；每个实例再绑定自己的停止信号与调用所有权。
    const unavailable = (): never => {
      throw new Error("EXTRA_EXECUTION_NOT_BOUND");
    };
    this.plugins = new ExtraPlugins(
      [],
      {
        invoke: createInputInvoke(unavailable),
        cancel: unavailable,
        respondInteraction: unavailable
      },
      (name) => this.#logs.extra(name)
    );
  }

  load<D extends object>(
    module: ExtraPluginModule<D>,
    config: JsonObject,
    dependencies: Readonly<D>
  ): Promise<void> {
    return this.plugins.load(
      {
        name: module.name,
        default: (context, snapshot) => {
          const port = this.#createPort(context);
          return module.default({ ...context, adapterHost: port }, snapshot);
        }
      },
      config,
      dependencies
    );
  }

  #release(invocation: ActiveInvocation): void {
    if (this.#invocations.get(invocation.invocationId) === invocation) {
      this.#invocations.delete(invocation.invocationId);
      this.#runs.delete(invocation.runId);
    }
  }

  #createPort(context: ExtraContext): ExtraAdapterHost {
    const owned = new Set<ActiveInvocation>();
    const assertActive = (): void => {
      context.signal.throwIfAborted();
      if (!this.isActive()) throw new Error("EXTRA_ACCOUNT_CHANGED");
    };
    // 停止接纳立即生效；已接纳调用另行请求取消，IPC 保留到原消费者收尾。
    // 五秒为同一个 Extra 的共享截止时间，超时强制断开，不把取消回执当成执行完成。
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const disposalCancellations = new Set<Promise<void>>();
    const disposalFinishes = new Set<Promise<void>>();
    const beginDisposal = (): void => {
      if (deadline) return;
      deadline = setTimeout(() => {
        timedOut = true;
        for (const invocation of owned)
          invocation.controller.abort(new Error("EXTRA_DISPOSE_FAILED"));
      }, 5_000);
      for (const invocation of owned) {
        const cancelling = invocation.cancelForDisposal();
        disposalCancellations.add(cancelling);
        // 后登记的业务 disposer 可能先耗尽 owned；保留停止瞬间的真实消费结果。
        disposalFinishes.add(invocation.finished);
        void cancelling.catch(() => undefined);
      }
    };
    context.signal.addEventListener("abort", beginDisposal, { once: true });
    const port: ExtraAdapterHost = {
      list: async () => {
        assertActive();
        return callDaemon(this.socket, { method: "adapter.list" });
      },
      invoke: ((input: InvokeInput, environment: InvokeEnvironment = {}) => {
        // 此内部端口选择源帧视图；避免通用 wrapper 在完整 drain 后因旧 signal 抹掉终态。
        const frames = async function* (
          this: LocalExtras,
          input: InvokeInput,
          environment: InvokeEnvironment = {}
        ) {
          assertActive();
          environment.signal?.throwIfAborted();
          const request = identifyInvokeInput(input);
          if (this.#invocations.has(request.invocationId) || this.#runs.has(request.runId))
            throw new Error("EXECUTION_IDENTITY_CONFLICT");
          const controller = new AbortController();
          // environment.signal 仍支持普通调用立即取消；整个 Extra 停止时则走独立 drain。
          const callerAbort = (): void => {
            if (!context.signal.aborted) controller.abort(environment.signal?.reason);
          };
          environment.signal?.addEventListener("abort", callerAbort, { once: true });
          let accepted!: (value: boolean) => void;
          const acceptance = new Promise<boolean>((resolve) => {
            accepted = resolve;
          });
          let streamId: string | undefined;
          let cancellation: Promise<void> | undefined;
          let disposalCancellationStarted = false;
          // ACK 即建立取消所有权；不能等 Provider 首帧才取消卡住的已接纳调用。
          const source = invokeDaemonRun(
            this.socket,
            request,
            {
              ...environment,
              signal: controller.signal
            },
            {
              onReceipt: (receipt) => {
                streamId ??= receipt.stream_id;
                accepted(true);
              },
              cancellationHandled: () => disposalCancellationStarted
            }
          );
          let finished!: (error?: Error) => void;
          let streamError: Error | undefined;
          let terminal = false;
          const invocation: ActiveInvocation = {
            invocationId: request.invocationId,
            runId: request.runId,
            controller,
            source,
            accepted: false,
            finished: new Promise<void>((resolve, reject) => {
              finished = (error) => (error ? reject(error) : resolve());
            }),
            cancelForDisposal: () =>
              (cancellation ??= (async () => {
                if (!(await acceptance)) return;
                disposalCancellationStarted = true;
                // 仅取消本实例已经取得源帧的同一次调用，防止 runId 复用后跨归属取消。
                const info = await callDaemon<HostRunReceipt>(this.socket, {
                  method: "agent_run.get",
                  params: { run_id: request.runId }
                });
                // get 同时带窗口元数据；只验证原始 receipt 的七个严格字段。
                const receipt = {
                  run_id: info.run_id,
                  invocation_id: info.invocation_id,
                  stream_id: info.stream_id,
                  agent_session_id: info.agent_session_id,
                  session_generation: info.session_generation,
                  protocol_mode: info.protocol_mode,
                  protocol: info.protocol
                };
                assertHostRunReceipt(receipt);
                if (
                  receipt.invocation_id !== request.invocationId ||
                  receipt.agent_session_id !== request.sessionId ||
                  receipt.session_generation !== (request.sessionGeneration ?? 0) ||
                  receipt.protocol_mode !== (request.protocol_mode ?? "native") ||
                  receipt.run_id !== request.runId ||
                  receipt.stream_id !== streamId
                )
                  throw new Error("EXECUTION_IDENTITY_CONFLICT");
                await callDaemon(this.socket, {
                  method: "agent_run.cancel",
                  params: { run_id: request.runId }
                });
              })())
          };
          void invocation.finished.catch(() => undefined);
          this.#invocations.set(request.invocationId, invocation);
          this.#runs.add(request.runId);
          owned.add(invocation);
          try {
            for await (const frame of source) {
              invocation.accepted = true;
              accepted(true);
              terminal ||= isHostTerminal(frame);
              yield frame;
            }
            controller.signal.throwIfAborted();
          } catch (error) {
            if (context.signal.aborted)
              streamError = error instanceof Error ? error : new Error("EXTRA_DISPOSE_FAILED");
            throw error;
          } finally {
            accepted(false);
            finished(
              streamError ??
                (context.signal.aborted && !terminal
                  ? new Error("EXTRA_DISPOSE_FAILED")
                  : undefined)
            );
            environment.signal?.removeEventListener("abort", callerAbort);
            this.#release(invocation);
            owned.delete(invocation);
          }
        }.call(this, input, environment);
        return input.protocol_mode === "canonical" ? canonicalEvents(frames) : frames;
      }) as ExtraAdapterHost["invoke"],
      cancel: async (invocationId) => {
        const invocation = this.#invocations.get(invocationId);
        // 停止后的公开 cancel 只能观察本实例已有的清理取消，不新增任何取消权限。
        if (context.signal.aborted) {
          if (!invocation || !owned.has(invocation)) return { cancelled: false };
          await invocation.cancelForDisposal();
          return { cancelled: true };
        }
        assertActive();
        if (!invocation || !owned.has(invocation)) return { cancelled: false };
        invocation.controller.abort(new Error("caller_aborted"));
        // invokeDaemonRun 与服务端覆盖接纳前取消；不把 invocationId 错当作 runId。
        await invocation.source.return(undefined);
        this.#release(invocation);
        owned.delete(invocation);
        return { cancelled: true };
      },
      respondInteraction: async (invocationId, response) => {
        assertActive();
        const invocation = this.#invocations.get(invocationId);
        if (
          !invocation ||
          !owned.has(invocation) ||
          !invocation.accepted ||
          invocation.controller.signal.aborted
        )
          throw new Error("EXTRA_INVOCATION_NOT_ACTIVE");
        await callDaemon(this.socket, {
          method: "agent_run.respond",
          params: { run_id: invocation.runId, response }
        });
      }
    };
    context.onDispose(async () => {
      beginDisposal();
      try {
        const results = await Promise.allSettled([
          ...disposalCancellations,
          ...disposalFinishes,
          ...[...owned].map((invocation) => invocation.finished)
        ]);
        if (results.some((result) => result.status === "rejected") || owned.size || timedOut)
          throw new Error("EXTRA_DISPOSE_FAILED");
      } finally {
        clearTimeout(deadline);
        context.signal.removeEventListener("abort", beginDisposal);
      }
    });
    return port;
  }

  close(): Promise<void> {
    this.#closing ??= this.plugins.close().finally(() => this.#logs.close());
    return this.#closing;
  }
}
