---
type: Journal
title: 第三方 Extra 公开合同与发行验证
description: 公开类型闭包、隔离发行安装、真实 Codex 执行与 Adapter 待实施范围。
tags: [extra, adapter, typescript, testing]
timestamp: 2026-10-15T00:00:00Z
---

# 第三方 Extra 公开合同与发行验证

任务见 [公开插件合同](../../tasks/public-plugin-contracts/brief.md)。本轮开放单一发行包的 `/extra`、`/protocol`，内部 packages 保持 private。ExtraContext 的执行端口改为独立 ExtraAdapterHost，签名和运行语义不变，没有修改 Run/Context wire 协议。

## 已执行的验证

- `pnpm build`、根 `tsc --noEmit`、包含 public 目录的 ESLint 通过。
- `uv run --with pyyaml python .octospec/scripts/lint.py` 的 OKF 格式、规则索引和本地文件链接检查通过；`git diff --check` 通过。
- `node scripts/pack-release.mjs` 生成本地 tgz；没有发布 npm，没有替换已运行桌面程序或重置现有 Home/身份。
- `node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz` 通过：临时前缀、空缓存、offline 全局安装，仓库外 TS 插件以 skipLibCheck=false 编译，模式重载及非法交互类型检查有效，公开运行时入口可 import，编译 JS 通过 extraset 被真实 daemon 加载。根入口、内部深层路径和私有包直接 import 仍拒绝。
- 同命令加 `--live` 通过：发行物中的第三方 Extra 调用真实 Codex，收到 run.completed，final 文本精确匹配本次 marker。测试同时检查 im-test HTTP 可达；这只证明环境可达，不代表 Octo IM 注册、远程 AgentRun 或 Dify 链路通过。本轮真实执行是隔离本地 daemon → Codex。
- 全量 Node 回归：813 项，805 通过、7 跳过、1 失败。唯一失败为 adapter-icons.test.js 无法导入独立项目 `@mininglamp-oss/octo-runtime-adapter-icons`；根依赖指向 `../octo-runtime-adapter-icons`，当前工作区没有该目录。未伪造该依赖或修改测试以掩盖环境缺失。
- 测试创建的 daemon、Host 和临时安装前缀已回收；隔离卸载保留 Home 的断言通过，测试最后仅删除自身临时目录。

## 尚未实施

`/adapter` 公开入口、CLI TS 固定默认集合与 `<home>/extra_adapters.json` 合并在本记录验收时只更新了目标合同，尚未改造加载代码。Dify 独立 Adapter 未实现、未实测。随后用户明确 CLI 使用专属 JSON、SDK 直接 import，默认来源拆分已另行实施，见[后续记录](../../tasks/adapter-composition-ownership/brief.md)；追加清单及 Dify 仍按[装配任务](../../tasks/adapter-composition-ownership/brief.md)另行验收。

根 exports 原先为空的历史发行记录保留历史含义；从本次工作树开始仅两个声明子入口公开，任意私有实现仍不属于公开合同。最终安装版本是否具备这些入口以实际发布产物为准。
