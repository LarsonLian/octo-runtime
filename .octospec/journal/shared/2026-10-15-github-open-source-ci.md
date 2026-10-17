---
type: Journal
title: Runtime GitHub 开源 CI 验证记录
description: 单一 npm 包检查、组织工作流对照与本机验证结果。
tags: [ci, testing, release]
timestamp: 2026-10-15T00:00:00Z
---

# 修改与依据

范围见[任务简报](../../tasks/github-open-source-ci/brief.md)，操作见 [GitHub CI 说明](../../../.github/CI.md)。对照本机 Mininglamp-OSS 的 octo-cli 与 cc-channel-octo 工作流，通过 GitHub API 核对组织 v1 的工作流列表、Workflow Sanity、Secret Scan、Release Publish 与 CodeQL 合同。

新增 Linux/macOS CI、npm 单包发布、历史检查、安全检查与贡献维护工作流。npm 仅手动触发，默认 dry-run，校验稳定 tag、main 归属、版本并对精确提交重跑 CI，上传该次验证产物。GitHub Release 使用组织的同提交 CI 证据门禁。内部 workspace 不独立发布。

根 package.json 以及实际打包后的 manifest 指向预期公开仓库，保留已存在的打包方式及 prepack 守卫。许可证尚待权利人选择，未擅自添加整仓许可证。未配置依赖 PROJECT_TOKEN 的看板和 Sprint 门禁。

## 本机验证

- Node v24.19.0、pnpm 11.19.0。
- `pnpm install --frozen-lockfile --ignore-scripts`：通过，lockfile 与依赖一致；构建生命周期另由下述完整检查覆盖。
- `pnpm lint`、`pnpm lint:names`、`pnpm typecheck`：通过。
- `node --test test/*.test.js packages/octo-runtime-protocol/test/*.test.js`：832 项，825 通过、7 跳过、0 失败。跳过项依赖真实 Provider 显式开关。
- `node scripts/pack-release.mjs`：生成 1.0.0 tgz，包内 repository/homepage/bugs 为公开仓库地址。
- `node scripts/verify-release.mjs dist/release/mininglamp-oss-octo-runtime-1.0.0.tgz`：通过。空缓存离线安装、全局 CLI、daemon ready、公开类型编译、外部 Extra 加载、私有入口拒绝与卸载保留 Home 均通过；只操作隔离临时 Home。
- 发行验证最初使用通配符时误选本机遗留 0.1.0 tgz，断言失败；已将 CI 验证与 artifact 上传改为当前版本的精确文件路径，再验证 1.0.0 通过。
- actionlint v1.7.12：全部新增工作流通过。
- `uv run --with pyyaml python .octospec/scripts/lint.py`：107 个 OKF 单元、20 条规则、742 个本地文件链接通过。

## 后续：按用户要求补充许可证

用户明确参考 octo-cli，已采用 Apache-2.0。GitHub license API 返回 Apache-2.0，LICENSE blob 为 `fd67ecba2e6a69ffb57e12c3f9e87552fabdadc4`，与本机参考文件一致。根 LICENSE 沿用该正文和 Mininglamp Technology 版权方，Runtime 年份为 2026；前述“许可证待选择”是本次补充前的历史状态。

已补充 package.json.license、根与发行 README，更新 CI 准备说明。打包时 LICENSE 必须存在，发行安装验证检查 `license=Apache-2.0` 和完整正文一致，第三方声明继续保留。未给内部 workspace 批量改写第三方许可证。

验证：两个脚本 `node --check` 通过；重新打包与完整离线发行安装验证通过；LICENSE 与参考正文比较仅年份差异；OKF 校验通过（107 单元、20 规则、743 本地链接）。这次只改许可证、发行校验和说明，未重跑业务测试或线上联调。

## 运行与发布限制

本机是 macOS，Linux runner 与 GitHub 远端运行尚未验证。工作树已有其他任务的未提交改动，构建元数据诚实记录 dirty=true。本次没有修改线上接口、UI 或 Run/Context 协议，没有进行真实模型或线上业务联调；不将离线测试视为线上证据。没有推送、创建仓库、发布 npm 或 GitHub Release，也没有改写现有 Runtime 身份、Home、profile 和配置。
