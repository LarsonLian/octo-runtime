import test from "node:test";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as gateway from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { LocalExtras } from "../packages/octo-runtime-daemon/dist/runtime/local-extras.js";
import { identifyInvokeInput } from "@mininglamp-oss/octo-runtime-protocol";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDaemonRuntime,
  createContextLoader
} from "../packages/octo-runtime-daemon/dist/index.js";
import { executionContext, deferred, waitFor } from "./runtime-fixture.js";

const entrypoint = fileURLToPath(new URL("./fixtures/sdk-extra-host.js", import.meta.url));
const account = { subject: { type: "user", id: "sdk-host" }, tenants: [{ id: "space" }] };
const collect = async (source) => {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
};
const item = (text) => ({ namespace: "extra.test", name: "current", payload: { text } });
const input = (prompt = "inspect-input", extra = {}) => ({
  inputs: [{ type: "text", text: prompt }],
  contexts: executionContext({
    adapter_type: "test",
    workdir: process.cwd(),
    approval_mode: "full_access"
  }),
  protocol_mode: "canonical",
  ...extra
});
const codexInput = (prompt, extra = {}) =>
  input(prompt, {
    contexts: executionContext({
      adapter_type: "codex",
      workdir: process.cwd(),
      approval_mode: "ask"
    }),
    ...extra
  });

async function fixture(t, options = {}) {
  const home = await mkdtemp("/tmp/sdk-host-extras-");
  const runtime = createDaemonRuntime({
    appId: "sdk-host-extra-test",
    home,
    distribution: { adapterHostEntrypoint: entrypoint },
    healthPollIntervalMs: 20,
    ...options
  });
  t.after(async () => {
    await runtime.stop().catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });
  return { home, runtime };
}

test(
  "SDK injects live host functions and preserves the independent execution path",
  { timeout: 15000 },
  async (t) => {
    const { home, runtime } = await fixture(t);
    let port,
      nextRound,
      calls = 0,
      current = "A",
      callbackConfig;
    const callback = (config, { signal }) => {
      signal.throwIfAborted();
      callbackConfig = config;
      calls++;
      return current === "A" ? [item(current)] : Promise.resolve([item(current)]);
    };
    const module = {
      name: "dynamic",
      default(context, config) {
        port = context.adapterHost;
        return (dependencies) => {
          assert.equal(dependencies.loadContexts, callback);
          assert.equal(Object.isFrozen(dependencies), true);
          const loader = createContextLoader(dependencies.loadContexts, undefined, context.signal);
          context.onDispose(() => loader.close());
          context.onStatus(() => ({ bot: config.bot.id }));
          nextRound = async () => {
            const items = await loader.load(config.bot, context.signal);
            const request = input();
            request.contexts.items.push(...items);
            const events = await collect(
              port.invoke(request, {
                executionEnvOverrides: {
                  env_variables: [{ key: "OCTO_TEST_EXTRA", value: "per-invocation" }]
                }
              })
            );
            return JSON.parse(events.find((event) => event.type === "message.delta").payload.text);
          };
        };
      }
    };
    await assert.rejects(
      runtime.loadExtra(module, {}, { loadContexts: callback }),
      /HOST_NOT_RUNNING/
    );
    await runtime.startAccount(account);
    const pid = runtime.health().local.pid;
    const config = {
      bot: { id: "one", context: { schema: "octo.context-envelope/v3", items: [] } }
    };
    const loading = runtime.loadExtra(module, config, { loadContexts: callback });
    config.bot.id = "mutated-after-call";
    const status = await loading;
    assert.equal(status.dynamic.phase, "loaded");
    assert.equal(calls, 0);
    assert.deepEqual(await runtime.extraStatus("dynamic"), { bot: "one" });
    const first = await nextRound();
    current = "B";
    const second = await nextRound();
    assert.equal(first.context.items.at(-1).payload.text, "A");
    assert.equal(second.context.items.at(-1).payload.text, "B");
    assert.deepEqual(first.executionEnvOverrides, {
      env_variables: [{ key: "OCTO_TEST_EXTRA", value: "per-invocation" }]
    });
    assert.equal(calls, 2);
    assert.equal(callbackConfig.id, "one");
    assert.notEqual(first.pid, process.pid);
    assert.equal(first.pid, second.pid);
    assert.equal(runtime.health().local.pid, pid);
    assert.ok((await port.list()).some((adapter) => adapter.type === "codex"));
    await waitFor(() => runtime.health().extras?.dynamic?.phase === "loaded");
    const events = [];
    const unsubscribe = runtime.onHealth((health) => events.push(health.extras?.dynamic?.phase));
    await new Promise((resolve) => setTimeout(resolve, 80));
    unsubscribe();
    assert.ok(events.length > 1);
    assert.ok(events.every((phase) => phase === "loaded"));
    // Runner 的会话声明仅包含 JSON；宿主回调不进入 runner 的启动文件。
    const sessionFiles = [];
    async function scan(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await scan(child);
        else if (entry.name === "embedded-session.json")
          sessionFiles.push(await readFile(child, "utf8"));
      }
    }
    await scan(home);
    assert.equal(sessionFiles.length, 1);
    assert.ok(
      sessionFiles.every((text) => !text.includes("loadContexts") && !text.includes('"dynamic"'))
    );
    await runtime.unloadExtra("dynamic");
    assert.equal((await runtime.extraStatus()).dynamic.phase, "disposed");
    await assert.rejects(runtime.extraStatus("dynamic"), /EXTRA_NOT_LOADED/);
    await assert.rejects(collect(port.invoke(input())), /abort/i);
    assert.equal(runtime.health().local.pid, pid);
    await runtime.loadExtra(module, { bot: { id: "two" } }, { loadContexts: callback });
    assert.deepEqual(await runtime.extraStatus("dynamic"), { bot: "two" });
  }
);

test(
  "SDK keeps local and JSON declarations mutually exclusive across reload and restart",
  { timeout: 15000 },
  async (t) => {
    const { home, runtime } = await fixture(t);
    const remote = join(home, "same.mjs");
    await writeFile(
      remote,
      "export const name='same'; export default ctx => () => { ctx.onStatus(() => ({ location: 'runner' })); };"
    );
    const descriptor = { name: "same", module: remote, config: {} };
    const module = {
      name: "same",
      default: (ctx) => () => {
        ctx.onStatus(() => ({ location: "host" }));
      }
    };
    await runtime.startAccount(account);
    await runtime.loadExtra(descriptor);
    await assert.rejects(runtime.loadExtra(module, {}, {}), /EXTRA_ALREADY_LOADED/);
    await runtime.unloadExtra("same");
    await runtime.loadExtra(module, {}, {});
    await assert.rejects(runtime.loadExtra(descriptor), /EXTRA_ALREADY_LOADED/);
    await assert.rejects(runtime.loadExtra(module, {}, {}), /EXTRA_ALREADY_LOADED/);
    assert.deepEqual(await runtime.extraStatus("same"), { location: "host" });
    await runtime.stop("reconfigure");
    await runtime.startAccount(account);
    assert.equal((await runtime.extraStatus()).same, undefined);
    await runtime.loadExtra(module, {}, {});
    await runtime.unloadExtra("same");
    await runtime.loadExtra(descriptor);
    assert.deepEqual(await runtime.extraStatus("same"), { location: "runner" });
    await runtime.stop("reconfigure");
    await runtime.startAccount(account);
    assert.deepEqual(await runtime.extraStatus("same"), { location: "runner" });
  }
);

for (const action of ["unload", "quit", "account-switch", "tenants"]) {
  test(
    `SDK immediately aborts local initialization on ${action}`,
    { timeout: 15000 },
    async (t) => {
      const { runtime } = await fixture(t);
      const entered = deferred();
      let disposed = 0,
        enteredCount = 0;
      const module = {
        name: "pending",
        default(ctx) {
          return async () => {
            enteredCount++;
            ctx.onDispose(() => {
              disposed++;
            });
            entered.resolve();
            await new Promise((resolve) =>
              ctx.signal.addEventListener("abort", resolve, { once: true })
            );
          };
        }
      };
      await runtime.startAccount(account);
      const pending = runtime.loadExtra(module, {}, {});
      const rejected = assert.rejects(pending, /EXTRA_LOAD_CANCELLED/);
      await entered.promise;
      if (action === "unload") await runtime.unloadExtra("pending");
      else if (action === "quit") await runtime.stop();
      else if (action === "account-switch") {
        const switching = runtime.startAccount({
          ...account,
          subject: { type: "user", id: "new" }
        });
        const stale = assert.rejects(runtime.unloadExtra("pending"), /EXTRA_ACCOUNT_CHANGED/);
        await switching;
        await stale;
      } else await runtime.reconcileTenants([{ id: "new-space" }]);
      await rejected;
      assert.equal(disposed, 1);
      await runtime.startAccount(account);
      const queued = assert.rejects(runtime.loadExtra(module, {}, {}), /EXTRA_LOAD_CANCELLED/);
      await runtime.unloadExtra("pending");
      await queued;
      assert.equal(enteredCount, 1);
    }
  );
}

test(
  "SDK maps interaction replies to their original Run and isolates Extra ownership",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t);
    let portA, portB;
    await runtime.startAccount(account);
    await runtime.loadExtra(
      {
        name: "one",
        default: (ctx) => () => {
          portA = ctx.adapterHost;
        }
      },
      {},
      {}
    );
    await runtime.loadExtra(
      {
        name: "two",
        default: (ctx) => () => {
          portB = ctx.adapterHost;
        }
      },
      {},
      {}
    );
    const invocationId = "sdk-question-invocation",
      runId = "sdk-question-run";
    const events = [];
    for await (const event of portA.invoke(codexInput("approval", { invocationId, runId }))) {
      events.push(event);
      if (event.type === "interaction.requested") {
        const response = { interactionId: event.payload.interactionId, outcome: "accepted" };
        assert.deepEqual(await portB.cancel(invocationId), { cancelled: false });
        await assert.rejects(
          portB.respondInteraction(invocationId, response),
          /EXTRA_INVOCATION_NOT_ACTIVE/
        );
        await portA.respondInteraction(invocationId, response);
      }
    }
    assert.ok(events.some((event) => event.type === "interaction.requested"));
    assert.equal(events.at(-1).type, "run.completed");
    await assert.rejects(
      portA.respondInteraction(invocationId, { interactionId: "late", outcome: "accepted" }),
      /EXTRA_INVOCATION_NOT_ACTIVE/
    );
    assert.deepEqual(await portA.cancel(invocationId), { cancelled: false });
  }
);

test(
  "SDK preserves native frames, cancels active calls, and unloads only their owning Extra",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t);
    const ports = [];
    await runtime.startAccount(account);
    for (const name of ["one", "two"]) {
      await runtime.loadExtra(
        {
          name,
          default: (ctx) => () => {
            ports.push(ctx.adapterHost);
          }
        },
        {},
        {}
      );
    }
    const frames = await collect(
      ports[0].invoke(codexInput("normal", { protocol_mode: "native" }))
    );
    assert.ok(
      frames.some((frame) => frame.kind === "native" && frame.payload.result?.future?.exact)
    );
    assert.equal(frames.at(-1).control.state, "completed");
    const started = [deferred(), deferred()];
    const tasks = ports.map((port, index) =>
      (async () => {
        for await (const frame of port.invoke(
          codexInput("hang", {
            protocol_mode: "native",
            invocationId: `hanging-${index}`,
            runId: `hanging-run-${index}`
          })
        )) {
          if (frame.kind === "native" && frame.payload.method === "item/agentMessage/delta")
            started[index].resolve();
        }
      })()
    );
    const stopped = [tasks[0], assert.rejects(tasks[1], /abort/i)];
    await Promise.all(started.map((value) => value.promise));
    await runtime.unloadExtra("one");
    await stopped[0];
    assert.equal((await runtime.extraStatus()).two.phase, "loaded");
    assert.deepEqual(await ports[1].cancel("hanging-1"), { cancelled: true });
    await stopped[1];
    assert.equal((await runtime.extraStatus()).two.phase, "loaded");
  }
);

test(
  "SDK cleanup failure stops the runner but blocks replacement, including a new account",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t);
    await runtime.startAccount(account);
    const pid = runtime.health().local.pid;
    let cleaned = 0;
    const module = {
      name: "broken",
      default: (ctx) => () => {
        ctx.onDispose(() => {
          cleaned++;
        });
        ctx.onDispose(() => {
          throw new Error("private failure body");
        });
      }
    };
    await runtime.loadExtra(module, {}, {});
    await assert.rejects(runtime.unloadExtra("broken"), /EXTRA_DISPOSE_FAILED/);
    await assert.rejects(runtime.loadExtra(module, {}, {}), /EXTRA_DISPOSE_FAILED/);
    assert.equal(cleaned, 1);
    assert.equal((await runtime.extraStatus()).broken.error, "EXTRA_DISPOSE_FAILED");
    await assert.rejects(runtime.stop(), /Extra cleanup failed/);
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    await assert.rejects(runtime.startAccount(account), /EXTRA_DISPOSE_FAILED/);
    await assert.rejects(
      runtime.startAccount({ ...account, subject: { type: "user", id: "other" } }),
      /EXTRA_DISPOSE_FAILED/
    );
  }
);

test(
  "SDK clears local closures on runner exit and does not revive them on restart",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t);
    await runtime.startAccount(account);
    let disposed = 0,
      signal;
    await runtime.loadExtra(
      {
        name: "owned",
        default: (ctx) => () => {
          signal = ctx.signal;
          ctx.onDispose(() => {
            disposed++;
          });
        }
      },
      {},
      {}
    );
    process.kill(runtime.health().local.pid, "SIGKILL");
    await waitFor(() => signal.aborted && disposed === 1);
    assert.equal(runtime.health().phase, "error");
    await runtime.startAccount(account);
    assert.equal((await runtime.extraStatus()).owned, undefined);
    await runtime.loadExtra({ name: "owned", default: () => () => {} }, {}, {});
  }
);

test(
  "SDK aborts an unloaded instance even while another Extra is initializing",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t);
    await runtime.startAccount(account);
    let firstSignal;
    await runtime.loadExtra(
      {
        name: "first",
        default: (ctx) => () => {
          firstSignal = ctx.signal;
        }
      },
      {},
      {}
    );
    const entered = deferred();
    const initializing = runtime.loadExtra(
      {
        name: "second",
        default: (ctx) => async () => {
          entered.resolve();
          await new Promise((resolve) =>
            ctx.signal.addEventListener("abort", resolve, { once: true })
          );
        }
      },
      {},
      {}
    );
    const cancelled = assert.rejects(initializing, /EXTRA_LOAD_CANCELLED/);
    await entered.promise;
    const unloading = runtime.unloadExtra("first");
    assert.equal(firstSignal.aborted, true);
    const stopping = runtime.stop();
    await cancelled;
    await unloading;
    await stopping;
  }
);

test(
  "SDK initialization failure cleans resources and permits a fresh function binding",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t);
    await runtime.startAccount(account);
    let cleaned = 0,
      read;
    const module = {
      name: "retry",
      default: (ctx) => (dependencies) => {
        ctx.onDispose(() => {
          cleaned++;
        });
        read = dependencies.read;
        if (dependencies.fail) throw new Error("business initialization failed");
        ctx.onStatus(() => ({ value: read() }));
      }
    };
    await assert.rejects(
      runtime.loadExtra(module, {}, { read: () => "old", fail: true }),
      /business initialization failed/
    );
    assert.equal(cleaned, 1);
    assert.deepEqual((await runtime.extraStatus()).retry, {
      phase: "error",
      error: "EXTRA_LOAD_FAILED"
    });
    await runtime.loadExtra(module, {}, { read: () => "new", fail: false });
    assert.deepEqual(await runtime.extraStatus("retry"), { value: "new" });
    await runtime.unloadExtra("retry");
    assert.equal(cleaned, 2);
  }
);

test(
  "SDK shares the 64 declaration capacity between JSON and host modules",
  { timeout: 15000 },
  async (t) => {
    const { runtime } = await fixture(t, {
      extras: Array.from({ length: 64 }, (_, i) => ({
        name: `configured-${i}`,
        module: "not-imported-while-disabled",
        config: {},
        enabled: false
      }))
    });
    await runtime.startAccount(account);
    await assert.rejects(
      runtime.loadExtra({ name: "overflow", default: () => () => {} }, {}, {}),
      /EXTRA_CAPACITY_EXHAUSTED/
    );
    await runtime.loadExtra({ name: "configured-0", default: () => () => {} }, {}, {});
    assert.equal(Object.keys(await runtime.extraStatus()).length, 64);
    await assert.rejects(
      runtime.loadExtra({ name: "overflow", default: () => () => {} }, {}, {}),
      /EXTRA_CAPACITY_EXHAUSTED/
    );
  }
);

// 使用真实 LocalExtras → JSON-RPC socket，避免 fake invoke 忽略 signal 而掩盖提前断流。
for (const mode of [
  "drain",
  "ack-only",
  "ack-lost",
  "gateway",
  "gateway-stream-failed",
  "early-break",
  "identity-conflict",
  "stream-conflict",
  "cancel-failed",
  "timeout"
]) {
  test(
    `SDK Extra disposal keeps its IPC stream for tail bindings: ${mode}`,
    { timeout: 15000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "sdk-extra-drain-"));
      const socketPath =
        process.platform === "win32"
          ? "\\\\.\\pipe\\octo-extra-drain-" + randomUUID()
          : join(root, "daemon.sock");
      const connections = new Set();
      const started = deferred();
      const tailRead = deferred();
      let request,
        streamSocket,
        cancels = 0;
      const receipt = () => ({
        run_id: request.runId,
        invocation_id: request.invocationId,
        stream_id: "draining-stream",
        agent_session_id: request.sessionId,
        session_generation: request.sessionGeneration ?? 0,
        protocol_mode: "canonical",
        protocol: "test.canonical"
      });
      const write = (socket, value) => socket.write(JSON.stringify(value) + "\n");
      let sequence = 0;
      const emit = (event) =>
        write(streamSocket, {
          jsonrpc: "2.0",
          method: "agent_run.event",
          params: {
            run_id: request.runId,
            stream_id: "draining-stream",
            seq: ++sequence,
            event: { ...receipt(), seq: sequence, ...event }
          }
        });
      const tail = () => {
        emit({
          kind: "canonical",
          event: {
            protocolVersion: 2,
            type: "session.update",
            payload: { providerSession: { sessionId: "after-cancel" } }
          }
        });
        emit({
          kind: "canonical",
          event: { protocolVersion: 2, type: "run.cancelled", payload: {} }
        });
        emit({ kind: "control", control: { type: "state", state: "cancelled" } });
      };
      const server = createServer((socket) => {
        connections.add(socket);
        socket.on("close", () => connections.delete(socket));
        socket.setEncoding("utf8");
        let pending = "";
        socket.on("data", (chunk) => {
          pending += chunk;
          const newline = pending.indexOf("\n");
          if (newline < 0) return;
          const rpc = JSON.parse(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (rpc.method === "agent_run.invoke") {
            request = identifyInvokeInput(rpc.params.input);
            streamSocket = socket;
            if (mode === "ack-lost") {
              started.resolve();
              return;
            }
            write(socket, { jsonrpc: "2.0", id: rpc.id, result: receipt() });
            if (["ack-only", "gateway", "gateway-stream-failed"].includes(mode)) started.resolve();
            else
              emit({
                kind: "canonical",
                event: { protocolVersion: 2, type: "run.started", payload: {} }
              });
          } else if (rpc.method === "agent_run.get") {
            write(socket, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                ...receipt(),
                oldest_seq: 1,
                latest_seq: sequence,
                ...(mode === "identity-conflict" ? { invocation_id: "different-owner" } : {}),
                ...(mode === "stream-conflict" ? { stream_id: "different-stream" } : {})
              }
            });
            if (["identity-conflict", "stream-conflict"].includes(mode)) tail();
          } else if (rpc.method === "agent_run.cancel") {
            cancels++;
            if (mode === "gateway-stream-failed")
              write(streamSocket, {
                jsonrpc: "2.0",
                method: "agent_run.stream_error",
                params: { run_id: request.runId, stream_id: "draining-stream", code: "STREAM_GAP" }
              });
            else if (!["timeout", "ack-lost"].includes(mode)) tail();
            write(socket, {
              jsonrpc: "2.0",
              id: rpc.id,
              ...(mode === "cancel-failed"
                ? { error: { message: "cancel rejected" } }
                : { result: { cancelled: true } })
            });
          } else assert.fail(`unexpected RPC ${rpc.method}`);
        });
      });
      await new Promise((resolve) => server.listen(socketPath, resolve));
      const local = new LocalExtras(socketPath, () => true);
      t.after(async () => {
        await local.close().catch(() => undefined);
        for (const socket of connections) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        await rm(root, { recursive: true, force: true });
      });
      let consumed,
        signal,
        binding,
        storeClosed = 0;
      if (mode.startsWith("gateway")) {
        let callbacks;
        t.mock.method(GatewayTransport.prototype, "start", async function () {
          callbacks = this.callbacks;
        });
        t.mock.method(GatewayTransport.prototype, "close", async () => {});
        await local.load(
          gateway,
          {
            bots: [
              {
                bot_id: "bot",
                api_url: "https://example.com/api",
                adapter: { adapter_type: "test", workdir: process.cwd() }
              }
            ]
          },
          {
            createSessionStore() {
              const store = new gateway.MemoryImSessionStore();
              const save = store.save.bind(store),
                close = store.close.bind(store);
              store.save = (key, value) => {
                binding = structuredClone(value);
                save(key, value);
              };
              store.close = () => {
                if (mode === "gateway")
                  assert.equal(binding.providerSession.sessionId, "after-cancel");
                storeClosed++;
                close();
              };
              return store;
            }
          }
        );
        callbacks.onMessage({
          messageId: "tail",
          senderId: "sender",
          conversationId: "chat",
          conversationKind: "direct",
          text: "hello",
          buildContext: async () => ({ schema: "octo.context-envelope/v3", items: [] }),
          reply: async () => {
            assert.fail("no final delivery after shutdown");
          }
        });
      } else
        await local.load(
          {
            name: "draining",
            default: (ctx) => () => {
              signal = ctx.signal;
              const consuming = (async () => {
                for await (const event of ctx.adapterHost.invoke(input("drain"), {
                  signal: ctx.signal
                })) {
                  if (event.type === "run.started") started.resolve();
                  if (event.type === "session.update") {
                    assert.equal(ctx.signal.aborted, true);
                    assert.equal(event.payload.providerSession.sessionId, "after-cancel");
                    tailRead.resolve();
                    if (mode === "early-break") break;
                  }
                }
              })();
              consumed = ["timeout", "ack-lost"].includes(mode)
                ? assert.rejects(consuming, /EXTRA_DISPOSE_FAILED|abort/i)
                : consuming;
              ctx.onDispose(() => consumed);
            }
          },
          {},
          {}
        );
      await started.promise;
      const closing = local.plugins.unload(mode.startsWith("gateway") ? gateway.name : "draining");
      if (!mode.startsWith("gateway")) assert.equal(signal.aborted, true);
      if (["drain", "ack-only", "gateway"].includes(mode)) await closing;
      else {
        await assert.rejects(closing, /EXTRA_DISPOSE_FAILED/);
        await assert.rejects(
          local.load(
            {
              name: mode.startsWith("gateway") ? gateway.name : "draining",
              default: () => () => {}
            },
            {},
            {}
          ),
          /EXTRA_ALREADY_LOADED|EXTRA_DISPOSE_FAILED/
        );
      }
      await consumed;
      if (!["timeout", "ack-lost"].includes(mode) && !mode.startsWith("gateway"))
        await tailRead.promise;
      if (mode.startsWith("gateway")) assert.equal(storeClosed, 1);
      assert.equal(cancels, ["identity-conflict", "stream-conflict"].includes(mode) ? 0 : 1);
    }
  );
}
