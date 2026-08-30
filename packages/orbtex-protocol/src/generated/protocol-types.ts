/* eslint-disable */
/**
 * 本文件由 scripts/gen-types.mjs 从 schema/protocol.schema.json 自动生成。
 * 请勿手改；改协议请编辑 schema 后运行 `pnpm gen`。
 */

/**
 * assistant 输出频道。analysis 用于 provider 明确允许展示的思考/进度内容，final 用于面向用户的回答。
 *
 * This interface was referenced by `OrbtexProtocolSchema`'s JSON-Schema
 * via the `definition` "MessageChannel".
 */
export type MessageChannel = "analysis" | "final";

/**
 * Orbtex NDJSON 线协议的数据形状定义。这里只描述可 JSON 序列化的结构体；运行时行为（envelope、assert、isTerminal）、事件类型枚举常量与携带 AbortSignal 的 InvokeRequest 仍由 src/index.ts 手写组合。本文件是 TS 类型的唯一来源，改动后需运行 pnpm gen 重新生成。
 */
export interface OrbtexProtocolSchema {}
/**
 * Provider 自己拥有的会话恢复信息。sessionId 对 Core 完全 opaque；额外字段可由 adapter 写入并在下一次调用时原样取回。
 *
 * This interface was referenced by `OrbtexProtocolSchema`'s JSON-Schema
 * via the `definition` "ProviderSession".
 */
export interface ProviderSession {
  /**
   * Provider 私有的会话标识，Core 不解释其内容。
   */
  sessionId: string;
  /**
   * 当前 provider 是否声明该 session 可在后续 invocation 中恢复。
   */
  resumable?: boolean;
  [k: string]: unknown;
}
/**
 * Agent 的持久配置。公共字段供现有 adapters 使用，扩展字段必须由对应 adapter 自行解释；Core 只负责保存和传递，不根据 provider 类型分支处理。
 *
 * This interface was referenced by `OrbtexProtocolSchema`'s JSON-Schema
 * via the `definition` "AgentConfig".
 */
export interface AgentConfig {
  /**
   * Provider CLI 的默认工作目录；它是 cwd，不是文件系统安全边界。
   */
  workdir?: string;
  /**
   * 模型名。
   */
  model?: string;
  /**
   * provider 的 sandbox 模式标识。
   */
  sandbox?: string;
  /**
   * provider 的权限模式标识。
   */
  permissionMode?: string;
  /**
   * 是否危险地跳过权限确认；仅在明确授权场景使用。
   */
  dangerouslyBypassPermissions?: boolean;
  /**
   * 是否自动批准工具调用。
   */
  autoApprove?: boolean;
  /**
   * provider 侧的 agent 标识。
   */
  providerAgentId?: string;
  /**
   * thinking/推理档位标识。
   */
  thinking?: string;
  /**
   * 单次调用超时秒数。
   */
  timeoutSeconds?: number;
  /**
   * OpenClaw 配置文件路径。
   */
  openclawConfigPath?: string;
  /**
   * OpenClaw 状态目录。
   */
  openclawStateDir?: string;
  /**
   * provider 私有的扩展选项；Core 原样透传，不做解释。
   */
  providerOptions?: Record<string, unknown>;
  [k: string]: unknown;
}
/**
 * Canonical event 的公共 payload。开放字典用于容纳 tool/surface/usage 的结构化字段；常用生命周期字段在此显式列出，让 adapter 作者获得类型提示，同时避免把 provider-native 对象塞进顶层协议。
 *
 * This interface was referenced by `OrbtexProtocolSchema`'s JSON-Schema
 * via the `definition` "CanonicalEventPayload".
 */
export interface CanonicalEventPayload {
  providerSession?: ProviderSession;
  channel?: MessageChannel;
  /**
   * 消息稳定 ID。
   */
  messageId?: string;
  /**
   * 消息角色，如 assistant。
   */
  role?: string;
  /**
   * 工具调用或 run 的状态标识。
   */
  status?: string;
  /**
   * 文本增量或完整文本。
   */
  text?: string;
  /**
   * 终止或错误原因。
   */
  reason?: string;
  /**
   * 面向人类的说明信息。
   */
  message?: string;
  [k: string]: unknown;
}
/**
 * envelope 只需要 Run 的稳定标识，不要求传入完整领域对象。
 *
 * This interface was referenced by `OrbtexProtocolSchema`'s JSON-Schema
 * via the `definition` "RunIdentity".
 */
export interface RunIdentity {
  /**
   * Run ID。
   */
  id: string;
  /**
   * 所属 Harness Session ID。
   */
  sessionId: string;
}
/**
 * Core 发给 Adapter Host 的一次执行请求的可序列化部分。运行中携带的 AbortSignal 不可跨进程序列化，由 src/index.ts 在此基础上交叉出完整 InvokeRequest。session、run、invocation 是三个不同层次的标识：session 跨多轮复用，run 表示一次业务执行，invocation 表示这次与 provider adapter 的活动调用，用于取消和事件路由。
 *
 * This interface was referenced by `OrbtexProtocolSchema`'s JSON-Schema
 * via the `definition` "InvokeRequestWire".
 */
export interface InvokeRequestWire {
  /**
   * Adapter Host 活动调用 ID，也是 cancel 的目标。
   */
  invocationId: string;
  /**
   * Chat 或 Task 的长期 Harness Session ID。
   */
  sessionId: string;
  /**
   * 本次业务执行的 Run ID。
   */
  runId: string;
  /**
   * 用户请求或 Task description；不得混入 provider 私有控制参数。
   */
  prompt: string;
  /**
   * Provider 进程 cwd；真正的访问控制由 sandbox/容器/宿主权限提供。
   */
  workdir: string;
  /**
   * Harness 生成的控制指令，由 adapter 放入 provider 支持的私有 carrier。
   */
  appendInstructions: string;
  /**
   * 供 prompt、审计和未来 transport 使用的结构化 Harness 上下文。
   */
  context: Record<string, unknown>;
  providerSession?: ProviderSession;
  agentConfig: AgentConfig;
}
