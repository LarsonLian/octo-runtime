// 单一发行包的 Gateway 函数式入口；不会在 import 时建立连接或创建存储。
export { default, name } from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
export type {
  GatewayDependencies,
  ImSessionStore,
  ImSessionBinding,
  ImSessionOccurrence
} from "@mininglamp-oss/octo-runtime-extra-channel-gateway";
