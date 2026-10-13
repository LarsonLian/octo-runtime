/**
 * 公共入口：向 SDK/Daemon 暴露接入能力和协议类型。
 * 装配由宿主显式完成；导入本包不会读配置目录、建立连接或启动 AgentRun。
 */
export { ImRuntime } from "./application/im-channel.js";
export { ImChannelManager } from "./lifecycle/manager.js";
export { MemoryImSessionStore, SqliteImSessionStore } from "./application/session-store.js";
export type { ImSessionStore, ImSessionBinding } from "./application/session-store.js";
export { validateImConfig, imBotIdentity } from "./lifecycle/configuration.js";
export { build_im_contexts } from "./connectors/octo/contexts.js";
export { registerBot, WukongConnection } from "./connectors/octo/wukong.js";
export type { ImMessage, BotRegistration } from "./connectors/octo/wukong.js";
export { WecomConnection } from "./connectors/wecom/connection.js";
export type {
  WecomCredentials,
  WecomConnectionOptions,
  WecomConnectionStatus
} from "./connectors/wecom/connection.js";
export type * from "./contracts.js";
export type * from "./ports.js";
export * as imApi from "./connectors/octo/api/index.js";
export { loadImBots, configuredCredential } from "./lifecycle/file-config.js";
