/**
 * 平台装配入口：按配置选择 Octo 或企业微信 IM connector。
 * 公共编排只依赖统一端口；新增平台无需把平台协议分支塞进 AgentRun。
 */
import type { ImBotConfig, ImConnector, ImConnectorCallbacks } from "../contracts.js";
import type { ImCredentialSource } from "../ports.js";
import { OctoChannelConnector } from "./octo/channel.js";
import { WecomChannelConnector } from "./wecom/channel.js";

/** 内置 IM 平台连接器的装配点，与 MCP 工具连接器 / MCP Server 无关。 */
export function createImConnector(
  config: ImBotConfig,
  credentials: ImCredentialSource,
  callbacks: ImConnectorCallbacks
): ImConnector {
  switch (config.type) {
    case "octo":
      return new OctoChannelConnector(config, credentials, callbacks);
    case "wecom":
      return new WecomChannelConnector(config, credentials, callbacks);
  }
}
