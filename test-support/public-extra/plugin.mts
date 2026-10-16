import { writeFile } from "node:fs/promises";
import {
  InvokeInput,
  CONTEXT_SCHEMA,
  isTerminal,
  type ExtraPlugin,
  type ExtraContext,
  type ExtraAdapterHost,
  type ExtraDescriptor,
  type ExtraPluginModule,
  ExtraPlugins,
  type ChannelDependencies,
  type JsonObject,
  type CanonicalEvent,
  type HostFrame,
  type InteractionResponse,
  type ContextEnvelope,
  type ModelInputPart,
  type AgentConfig,
  type ProviderSession,
  type RuntimeLimits,
  type McpServers,
  type ContextMcpPayload,
  type FailureEnvelope
} from "@mininglamp-oss/octo-runtime/extra";
import { assertCanonicalEvent } from "@mininglamp-oss/octo-runtime/protocol";

export const name = "public-extra";

// 编译器必须保留 invoke 的模式重载、事件判别联合及交互参数检查。
export async function checkPort(ctx: ExtraContext, input: InvokeInput): Promise<void> {
  const host: ExtraAdapterHost = ctx.adapterHost;
  for await (const event of host.invoke({ ...input, protocol_mode: "canonical" })) {
    const typed: CanonicalEvent = event;
    assertCanonicalEvent(typed);
    // @ts-expect-error canonical 事件不是 native 源帧。
    const frame: HostFrame = event;
    void frame;
  }
  for await (const frame of host.invoke({ ...input, protocol_mode: "native" })) {
    const typed: HostFrame = frame;
    void typed;
  }
  const response: InteractionResponse = { interactionId: "approval-1", outcome: "accepted" };
  await host.respondInteraction("invocation-1", response);
  await host.cancel("invocation-1", "customer cancelled");
  // @ts-expect-error 响应必须有 interactionId。
  await host.respondInteraction("invocation-1", { outcome: "accepted" });
}

export interface BusinessState {
  contexts: ContextEnvelope;
  inputs: ModelInputPart[];
  agent?: AgentConfig;
  session?: ProviderSession;
  limits?: RuntimeLimits;
  mcp?: McpServers;
  mcpContext?: ContextMcpPayload;
  failure?: FailureEnvelope;
  descriptor?: ExtraDescriptor;
  module?: ExtraPluginModule;
}

export function checkAssembly(loader: ExtraPlugins, module: ExtraPluginModule<ChannelDependencies>, config: JsonObject) {
  void loader.load(module, config, { loadContexts: (_config, { signal }) => {
    signal.throwIfAborted();
    return [];
  } });
  // @ts-expect-error Dynamic callbacks must return ContextItem arrays, not strings.
  void loader.load(module, config, { loadContexts: async () => "invalid" });
}

const load: ExtraPlugin = (ctx, config) => async () => {
  const state: JsonObject = { schema: CONTEXT_SCHEMA, stopped: false, events: 0 };
  ctx.onStatus(() => state);
  ctx.onDispose(() => {
    state.stopped = true;
  });
  if (config.input !== undefined) {
    const input = InvokeInput.check(config.input);
    let answer = "";
    for await (const event of ctx.adapterHost.invoke(
      { ...input, protocol_mode: "canonical" },
      { signal: ctx.signal }
    )) {
      assertCanonicalEvent(event);
      state.events = Number(state.events) + 1;
      if (event.type === "message.delta" && event.payload.channel === "final")
        answer += event.payload.text ?? "";
      if (isTerminal(event)) state.terminal = event.type;
    }
    state.answer = answer;
  }
  if (typeof config.resultFile === "string")
    await writeFile(config.resultFile, JSON.stringify(state));
};

export default load;
