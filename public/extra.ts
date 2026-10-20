export * from "./protocol.js";
export type {
  ExtraAdapterHost,
  ExtraContext,
  RuntimeLog,
  RuntimeLogLevel,
  ExtraDisposer,
  ExtraInitializer,
  ChannelDependencies,
  LoadContexts,
  ExtraPlugin,
  ExtraPluginModule,
  ExtraRegistration,
  ExtraStatus,
  ExtraStatusHandler,
  JsonObject,
  JsonValue
} from "@mininglamp-oss/octo-runtime-daemon/extra";
export { ExtraPlugins } from "@mininglamp-oss/octo-runtime-daemon/extra";
export type {
  ExtraDescriptor,
  StoredExtra
} from "@mininglamp-oss/octo-runtime-daemon/extra-config";

// 宿主可以从单一发行包取得 Gateway 工厂合同；daemon 不反向依赖业务插件。
export type { GatewayDependencies } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
export type {
  ImSessionStore,
  ImSessionBinding,
  ImSessionOccurrence
} from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
