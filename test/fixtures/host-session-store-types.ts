import type {
  GatewayDependencies,
  ImSessionStore,
  ImSessionBinding,
  ImSessionOccurrence
} from "@mininglamp-oss/octo-runtime/extra";
import type { DaemonRuntime, JsonObject } from "@mininglamp-oss/octo-runtime-daemon";
import * as gateway from "@mininglamp-oss/octo-runtime/extras/channel-gateway";

// 编译验收：公开类型可用于宿主实际实现，工厂无需断言或导入插件内部路径。
declare const runtime: DaemonRuntime;
declare const config: JsonObject;
declare const bindings: Map<string, ImSessionBinding>;
declare const occurrences: Map<string, ImSessionOccurrence>;
const store: ImSessionStore = {
  read: (key) => bindings.get(key),
  save: (key, binding) => {
    bindings.set(key, binding);
  },
  reset: (key) => {
    const next = { generation: (bindings.get(key)?.generation ?? 1) + 1 };
    bindings.set(key, next);
    return next;
  },
  occurrence: (key, id) => occurrences.get(JSON.stringify([key, id])),
  remember: (key, id, value) => {
    occurrences.set(JSON.stringify([key, id]), value);
  },
  close: async () => {}
};
const dependencies: GatewayDependencies = { createSessionStore: (_botConfig) => store };
void runtime.loadExtra(gateway, config, dependencies);
