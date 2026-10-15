---
name: octo-runtime
description: Operate, build, link, diagnose, and troubleshoot the Octo Runtime local Agent Runtime with the octo-runtime CLI. Use for Runtime Home or profile selection, daemon services, provider adapters, logs, local AgentRun inspection, and source deployments. Do not use it as the cloud control plane for creating Runs, resetting Sessions, or managing business triggers.
---

# Octo Runtime

Use `octo-runtime` as the current OS user's entrypoint for Runtime identity, native daemon lifecycle, provider checks, and local execution diagnostics. Keep Octo Runtime's local-runtime responsibility separate from Agent Worker and business-service control-plane responsibilities.

## Establish The Target

Before a state-changing command, determine and state:

- whether this is an installed package or this source checkout;
- the Runtime Home, using `--home PATH` consistently when it is not the platform default;
- the profile for adapter configuration or `doctor`, if it is not `default`;
- whether the daemon runs in the foreground or through the native user service.

One Runtime Home runs one daemon and adapter-host and can contain multiple trusted profiles. Each profile owns a server-assigned `runtime_id`, Runtime credential, WSS connection, and durable outbox. All profiles share `<home>/machine.json`; its `machine_id` is an untrusted installation grouping label, never ownership proof or a unique Runtime key. Use separate OS accounts for mutually untrusted identities.

Run `octo-runtime help` and the relevant `octo-runtime <group> --help` before relying on an option that may have changed. Normal successful output is JSON. Errors go to stderr and return nonzero.

## Choose The Correct Workflow

### Inspect And Diagnose

Start with the least invasive commands that answer the question:

```bash
octo-runtime doctor
octo-runtime daemon status
octo-runtime status
octo-runtime adapter list
octo-runtime adapter probe codex
```

Use `doctor` for installation, identity, credential permissions, native-service drift, IPC, or cloud-connectivity failures. Use `status` for the daemon's application state. Use `daemon status` when native service state also matters. Do not substitute log inspection for a failing `doctor` check.

### Prepare The Local Home

CLI 不提供 `login` 命令。直接运行 `octo-runtime daemon install` 或 `octo-runtime daemon run`；两者共用默认 Home，按需创建缺失的本地配置和 machine identity，保留已有配置、身份和凭据。显式 `--home` 优先于 `OCTO_RUNTIME_HOME`，然后使用平台默认目录。

登录、登记与共享属于可选 Extra，不是本地设备存在或执行的条件。不得以本地就绪推导云端注册或连接成功，也不得按历史重置说明删除现有身份。

### Manage The Daemon

Use the native user-service commands for an installed Runtime:

```bash
octo-runtime daemon install
octo-runtime daemon start
octo-runtime daemon stop
octo-runtime daemon restart
octo-runtime daemon uninstall
```

Prefer graceful stop, restart, and uninstall so active Runs drain first. Use `--force` only when the user explicitly wants to skip draining or graceful shutdown has demonstrably failed. `daemon uninstall` removes the native service definition but preserves identity, credentials, databases, outbox, and logs. Do not delete Runtime Home data unless the user separately and explicitly requests that destructive action.

Use `daemon run` for foreground debugging. `--verbose` may expose detailed operational context; still avoid reproducing sensitive log content in responses.

### Inspect Local Execution

Use these groups for the local reference and diagnostic projection:

```bash
octo-runtime agent-session list
octo-runtime agent-session get SESSION_ID
octo-runtime agent-run list
octo-runtime agent-run get RUN_ID
octo-runtime agent-run wait RUN_ID
```

For local Host logs, start with `OCTO_RUNTIME_DEBUG=1 octo-runtime daemon run` and read `$OCTO_RUNTIME_HOME/logs/adapter-host.log` (default Home: `~/.octo-runtime`). Logging is off by default. Complete AgentRun trajectory belongs to Worker.

`agent-run cancel RUN_ID` changes live execution state. Confirm the exact Run ID from current state and use it only under an explicit cancellation request.

These commands do not create production Runs, reset provider sessions, or provide cloud-authoritative state. Route those operations to Agent Worker APIs or `octo-cli harness`. Route task scheduling, retries, triggers, IM delivery, and other business semantics to their owning service.

## Build And Link From Source

Require Node.js 24+ and pnpm 11. From the repository root, install dependencies when needed:

```bash
pnpm install --frozen-lockfile
```

For a full local rebuild and global link, use the deployment entrypoint:

```bash
npm link --foreground-scripts
```

The root `prepare` lifecycle runs the complete `pnpm build` before npm creates the global package and command links. After TypeScript-only changes, `pnpm build` is normally sufficient because the link already targets the checkout. Re-run `npm link` when package `bin` or link metadata changes.

Refresh the current zsh command cache when needed, then verify both commands and the CLI:

```bash
rehash
command -v octo-runtime
command -v octo-runtime-daemon
octo-runtime help
```

Verify that the global package symlink resolves to the intended checkout; finding a command on PATH alone does not prove that the correct checkout is linked.

## Consult Repository Documentation

When operating from this checkout, use these sources instead of guessing version-specific behavior:

- [CLI operations](../../apps/cli/README.md) for current commands, state layout, and service behavior.
- [Deployments](../../DEPLOYMENTS.md) for build, link, package, and release procedures.
- [Project overview](../../README.md) for ownership boundaries, runtime architecture, and source debugging.

Publishing is a separate external mutation. Read the deployment procedure and perform its full validation sequence, but do not publish packages without an explicit request.

## Verify The Outcome

Match verification to the operation:

- build/link: check command resolution, resolved symlink target, and `octo-runtime help`;
- local initialization/service installation: run `doctor`, `daemon status`, and check actual local IPC readiness;
- adapter issue: run `adapter list` and probe only the affected adapter;
- Run issue: capture the Run state, canonical events, and scoped logs without exposing credentials or unnecessary sensitive fields.

Report the selected Home/profile, commands that materially changed state, success or failure, and the smallest actionable remediation for any failed check.
