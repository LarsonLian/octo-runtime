# GitHub 检查与发行

目标仓库为 `Mininglamp-OSS/octo-runtime`，只发布 `@mininglamp-oss/octo-runtime`。参考 `octo-cli` 与 `cc-channel-octo`，通用工作流复用组织 `Mininglamp-OSS/.github@v1`。组织实现的升级随 v1 生效；本仓直接使用的 Actions 固定到 commit，由 Dependabot 提议更新。

## 检查

`CI` 对 main push、所有面向 main 的 PR（包括纯文档和 draft）及手动运行执行完整检查，不使用路径过滤，避免 required checks 永久等待。Linux 与 macOS 均使用 Node 24、packageManager 指定的 pnpm 和冻结 lockfile，执行 lint、命名、类型、构建、Node 测试、单包打包及离线安装验证。测试使用 fake Provider，真实 Provider 测试维持原有显式开关。当前没有 Windows runner 的验证证据。

Linux 上传 `octo-runtime-release` artifact，保留 7 天。打包验证覆盖空缓存离线全局安装、CLI、daemon、第三方 Extra 类型编译/加载和卸载保留 Home；不自动安装 Provider。

另有历史关系检查、Secret Scan、Dependency Review、每周 CodeQL、Workflow Sanity、PR 标题/标签、Issue 欢迎、Stale 与 Release Drafter。需要组织 Project token 的 Sprint/看板流程暂不接入，避免新仓库在尚未配置 Project 时阻断贡献。

## 仓库准备

1. 在 GitHub 创建目标仓库并推送代码后启用 Actions，确认允许调用组织复用工作流。
2. 在 main 分支规则中选择实际运行产生的两个 `Build, test and package` 检查和安全检查；首次运行前不要猜测嵌套检查名称。
3. npm 发布配置 `NPM_TOKEN` secret，具有目标包的发布权限；开启 OIDC 权限用于 provenance。普通 PR CI 不读取该 token。
4. 项目按 octo-cli 使用 Apache-2.0，根 `LICENSE` 和 `package.json.license` 已补齐，发行包必须携带完整许可证；第三方依赖及 `.octospec/` 资源保留各自许可证与声明。

## npm 发行

1. 修改根 package.json 版本，合入 main，创建并推送已有提交的稳定 tag `vX.Y.Z`。
2. 在默认分支运行 `npm Publish`，填入 tag，保留 `dry_run=true` 验证。
3. 确认后再以 `dry_run=false` 运行。工作流校验 tag 在 main 历史中且版本匹配，以精确提交重新调用 CI，仅发布该次 CI 验证的 tgz，并附 provenance。内部 workspace 不单独发布。

发布稳定版本到 `latest`，本次不引入自动 dev 版或预发行策略。重跑实际发布前先检查 npm 是否已有同版本；npm 版本不可覆盖。禁止直接在仓库根执行 `npm publish`，已有 prepack 守卫继续生效。

## GitHub Release

`Release Drafter` 生成更新草稿。单独运行 `Release Publish`，传入 tag 以及该提交成功的顶层 `CI` run ID，默认保留草稿。组织工作流核对 CI 名称、提交 SHA 和成功状态。GitHub Release 与 npm 发布独立，不依赖 GITHUB_TOKEN 创建 Release 后触发另一个工作流；该事件不会自动级联触发 npm 发布。

所有本机验证及其限制见[本次记录](../.octospec/journal/shared/2026-10-15-github-open-source-ci.md)。远端 runner、npm 上传、GitHub Release 和仓库规则须在目标仓库建立后验证。
