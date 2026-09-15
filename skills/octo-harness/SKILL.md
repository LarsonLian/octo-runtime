---
name: octo-harness
description: Operate, build, link, diagnose, and troubleshoot the Octo Harness local Agent Runtime with the octo-harness CLI. Use for enrollment, Harness Home or profile selection, daemon services, provider adapters, logs, local AgentSession or AgentRun inspection, and source deployments. Do not use it as the cloud control plane for creating Runs, resetting Sessions, or managing business triggers.
---

# Octo Harness

Use `octo-harness` as the current OS user's entrypoint for Runtime identity, native daemon lifecycle, provider checks, and local execution diagnostics. Keep Octo Harness's local-runtime responsibility separate from Agent Worker and business-service control-plane responsibilities.

## Establish The Target

Before a state-changing command, determine and state:

- whether this is an installed package or this source checkout;
- the Harness Home, using `--home PATH` consistently when it is not the platform default;
- the profile for `login` or `doctor`, if it is not `default`;
- whether the daemon runs in the foreground or through the native user service.

One Harness Home runs one daemon and adapter-host and can contain multiple trusted profiles. Each profile owns a server-assigned `runtime_id`, Runtime credential, WSS connection, and durable outbox. All profiles share `<home>/machine.json`; its `machine_id` is an untrusted installation grouping label, never ownership proof or a unique Runtime key. Use separate OS accounts for mutually untrusted identities.

Run `octo-harness help` and the relevant `octo-harness <group> --help` before relying on an option that may have changed. Normal successful output is JSON; `events` defaults to source-marked terminal lines (`--json` emits raw envelopes), and `inspect` prints its loopback URL. Errors go to stderr and return nonzero.

## Choose The Correct Workflow

### Inspect And Diagnose

Start with the least invasive commands that answer the question:

```bash
octo-harness doctor
octo-harness daemon status
octo-harness status
octo-harness adapter list
octo-harness adapter probe codex
```

Use `doctor` for installation, identity, credential permissions, native-service drift, IPC, or cloud-connectivity failures. Use `status` for the daemon's application state. Use `daemon status` when native service state also matters. Do not substitute log inspection for a failing `doctor` check.

### Enroll Or Reconcile A Runtime

Use `login` only when the user asks to enroll or reconcile a Runtime. Read the enrollment grant from stdin; do not place a real `octo_enroll_` token in argv, logs, source files, or chat output.

```bash
printf '%s\n' 'octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN' | octo-harness login \
  --server-url https://example.invalid \
  --enroll-token-stdin
```

When Worker and Octo Web use different origins, pass `--agent-work-url`. For source debugging without a native service, follow the current `login --help` flags and run `octo-harness --home PATH daemon run` in the foreground.

Never print or copy `<home>/<profile>/credentials/runtime-token.json`. The final `octo_runtime_` credential binds directly to the Runtime and belongs only in its protected profile file and Worker-side hash. It is not interchangeable with service, provider, Human, or bot credentials.

Ordinary login reuses the saved Runtime without enrollment. Renewal with a fresh grant must use the existing trusted server and Worker and prove possession of the saved Runtime credential. Use a new profile for a different binding. Legacy `system_id`/`device_id` identities require fresh enrollment after the breaking Worker database reset; do not attempt a compatibility migration.

### Manage The Daemon

Use the native user-service commands for an installed Runtime:

```bash
octo-harness daemon install
octo-harness daemon start
octo-harness daemon stop
octo-harness daemon restart
octo-harness daemon uninstall
```

Prefer graceful stop, restart, and uninstall so active Runs drain first. Use `--force` only when the user explicitly wants to skip draining or graceful shutdown has demonstrably failed. `daemon uninstall` removes the native service definition but preserves identity, credentials, databases, outbox, and logs. Do not delete Harness Home data unless the user separately and explicitly requests that destructive action.

Use `daemon run` for foreground debugging. `--verbose` may expose detailed operational context; still avoid reproducing sensitive log content in responses.

### Inspect Local Execution

Use these groups for the local reference and diagnostic projection:

```bash
octo-harness logs path
octo-harness logs query RUN_ID
octo-harness agent-session list
octo-harness agent-session get SESSION_ID
octo-harness agent-run list
octo-harness agent-run get RUN_ID
octo-harness agent-run wait RUN_ID
octo-harness events --run-id RUN_ID
octo-harness events --follow
octo-harness inspect
```

Use `logs query` for durable local log records. Use `events` for the current bounded in-memory snapshot and add `--follow` only for a live tail. Complete AgentRun trajectory belongs to `octo-cli`, not this skill. Only use `--sensitive` when the user explicitly requests sensitive log fields and their disclosure is necessary.

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
command -v octo-harness
command -v octo-harness-daemon
octo-harness help
```

Verify that the global package symlink resolves to the intended checkout; finding a command on PATH alone does not prove that the correct checkout is linked.

## Consult Repository Documentation

When operating from this checkout, use these sources instead of guessing version-specific behavior:

- [CLI operations](../../apps/cli/README.md) for current commands, state layout, and service behavior.
- [Deployments](../../DEPLOYMENTS.md) for build, link, package, and release procedures.
- [Project overview](../../README.md) for ownership boundaries, runtime architecture, and source debugging.

Publishing or installer rollout is a separate external mutation. Read the deployment procedure and perform its full validation sequence, but do not publish packages or deploy installers without an explicit request.

## Verify The Outcome

Match verification to the operation:

- build/link: check command resolution, resolved symlink target, and `octo-harness help`;
- enrollment/service login: run `doctor`, `daemon status`, and when requested verify the selected Runtime is online;
- adapter issue: run `adapter list` and probe only the affected adapter;
- Run issue: capture the Run state, canonical events, and scoped logs without exposing credentials or unnecessary sensitive fields.

Report the selected Home/profile, commands that materially changed state, success or failure, and the smallest actionable remediation for any failed check.
