import {
  createInputInvoke,
  identifyInvokeInput,
  type HostFrame,
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
    const port: ExtraAdapterHost = {
      list: async () => {
        assertActive();
        return callDaemon(this.socket, { method: "adapter.list" });
      },
      invoke: createInputInvoke(
        async function* (
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
          const signal = AbortSignal.any([
            context.signal,
            controller.signal,
            ...(environment.signal ? [environment.signal] : [])
          ]);
          const source = invokeDaemonRun(this.socket, request, { ...environment, signal });
          const invocation: ActiveInvocation = {
            invocationId: request.invocationId,
            runId: request.runId,
            controller,
            source,
            accepted: false
          };
          this.#invocations.set(request.invocationId, invocation);
          this.#runs.add(request.runId);
          owned.add(invocation);
          try {
            for await (const frame of source) {
              invocation.accepted = true;
              yield frame;
            }
            signal.throwIfAborted();
          } finally {
            this.#release(invocation);
            owned.delete(invocation);
          }
        }.bind(this)
      ),
      cancel: async (invocationId) => {
        assertActive();
        const invocation = this.#invocations.get(invocationId);
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
      const results = await Promise.allSettled(
        [...owned].map(async (invocation) => {
          invocation.controller.abort();
          await invocation.source.return(undefined);
          this.#release(invocation);
          owned.delete(invocation);
        })
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("EXTRA_DISPOSE_FAILED");
    });
    return port;
  }

  close(): Promise<void> {
    this.#closing ??= this.plugins.close().finally(() => this.#logs.close());
    return this.#closing;
  }
}
