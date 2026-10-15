/**
 * 公共入口：向 SDK/Daemon 暴露接入能力和协议类型。
 * 装配由宿主显式完成；导入本包不会读配置目录、建立连接或启动 AgentRun。
 */
export { ImRuntime } from "./application/im-channel.js";
export { octoCliEnvironment } from "./execution/tool-environment.js";
export { default, name } from "./extra.js";
export { ImChannelManager } from "./lifecycle/manager.js";
export { MemoryImSessionStore } from "./application/session-store.js";
export type { ImSessionStore, ImSessionBinding } from "./application/session-store.js";
export { validateImConfig, imBotIdentity } from "./lifecycle/configuration.js";
export { build_im_contexts } from "./transport/contexts.js";
export { registerBot, WukongConnection } from "./transport/wukong.js";
export type { ImMessage, BotRegistration } from "./transport/wukong.js";
export type * from "./contracts.js";
export type * from "./ports.js";
export * as imApi from "./transport/api/index.js";
export { validateImBots, configuredCredential } from "./lifecycle/file-config.js";
