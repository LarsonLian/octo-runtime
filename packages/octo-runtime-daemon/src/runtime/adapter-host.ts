// SDK 自己维护的 Host 入口；这是代码选择，不读取或复制 CLI 的 default_adapters.json。
// 以下导入保留本 SDK 当前的 12 个默认实现，CLI 新增清单项不会自动改变这里。
// 客户产品只需 5 个时，可在自己的入口只 import 那 5 个，并传给 serveAdapterHost。
import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { codexAdapter } from "@mininglamp-oss/octo-runtime-adapter-codex";
import { claudeCodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-claude-code";
import { codebuddyAdapter } from "@mininglamp-oss/octo-runtime-adapter-codebuddy";
import { hermesAdapter } from "@mininglamp-oss/octo-runtime-adapter-hermes";
import { kimiCodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-kimi-code";
import { mcodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-mcode";
import { opencodeAdapter } from "@mininglamp-oss/octo-runtime-adapter-opencode";
import { openclawAdapter } from "@mininglamp-oss/octo-runtime-adapter-openclaw";
import { qoderCliAdapter } from "@mininglamp-oss/octo-runtime-adapter-qodercli";
import { qoderCliCnAdapter } from "@mininglamp-oss/octo-runtime-adapter-qoderclicn";
import { zcodeGuiAdapter } from "@mininglamp-oss/octo-runtime-adapter-zcode-gui";
import { antigravityAdapter } from "@mininglamp-oss/octo-runtime-adapter-antigravity";

// 实例只在这个独立子进程中创建和注册，daemon 通过 stdio RPC 调用。
// 宿主必须自行准备模块依赖与 Provider；此处不安装依赖，不表示 Provider 已可用。
// 重复类型会在就绪前报错，空数组则提供一个没有 Adapter 的控制服务。
serveAdapterHost([
  codexAdapter, claudeCodeAdapter, codebuddyAdapter, hermesAdapter,
  kimiCodeAdapter, mcodeAdapter, opencodeAdapter, openclawAdapter,
  qoderCliAdapter, qoderCliCnAdapter, zcodeGuiAdapter, antigravityAdapter
]);
