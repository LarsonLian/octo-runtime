/** macOS current-user service backend implemented with a LaunchAgent. */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  definitionDrift,
  escapeXml,
  normalizeServiceSpec,
  readDefinition,
  removeDefinition,
  runCommand,
  writeDefinition
} from "./common.js";
import { ServiceError } from "./errors.js";
import { NodeCommandRunner } from "./runner.js";
import type {
  CommandRunner,
  NormalizedServiceSpec,
  ServiceBackend,
  ServiceBackendOptions,
  ServiceProbe,
  ServiceSpec,
  ServiceState,
  ServiceStatus
} from "./types.js";

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Manage one LaunchAgent in the current user's `gui/<uid>` launchd domain.
 *
 * Definitions live under `~/Library/LaunchAgents`; no system LaunchDaemon or
 * privilege escalation is used. A loaded definition is reconciled only when
 * its bytes change, preserving idempotent setup behavior.
 */
export class LaunchdUserBackend implements ServiceBackend {
  readonly kind = "launchd-user" as const;
  readonly #platform: NodeJS.Platform;
  readonly #runner: CommandRunner;
  readonly #homeDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #uid: number;
  readonly #launchctl: string;

  /** Build a backend for the current macOS user, with injectable dependencies for tests. */
  constructor(options: ServiceBackendOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? new NodeCommandRunner();
    this.#homeDirectory = options.homeDirectory ?? process.env.HOME ?? "";
    this.#environment = options.environment ?? process.env;
    this.#uid = options.uid ?? process.getuid?.() ?? -1;
    this.#launchctl = options.launchctlPath ?? "/bin/launchctl";
  }

  /** Report whether `launchctl` can address this user's `gui/<uid>` domain; no plist is written. */
  async probe(): Promise<ServiceProbe> {
    if (this.#platform !== "darwin")
      return { supported: false, manager: this.kind, detail: "requires macOS" };
    if (this.#uid < 0 || !this.#homeDirectory) {
      return {
        supported: false,
        manager: this.kind,
        detail: "current user home or uid is unavailable"
      };
    }
    try {
      const result = await runCommand(
        this.#runner,
        this.kind,
        this.#launchctl,
        ["print", this.#domain()],
        {
          checked: false,
          env: this.#environment
        }
      );
      return result.exitCode === 0
        ? { supported: true, manager: this.kind }
        : {
            supported: false,
            manager: this.kind,
            detail: (result.stderr || result.stdout).trim() || "launchd user domain is unavailable"
          };
    } catch (error) {
      return {
        supported: false,
        manager: this.kind,
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /** Return what launchd is actually using plus whether the installed plist differs from `spec`. */
  async inspect(spec: ServiceSpec): Promise<ServiceStatus> {
    const normalized = this.#normalize(spec);
    const label = launchdLabel(normalized);
    const definitionPath = this.#definitionPath(label);
    const actual = await readDefinition(definitionPath);
    if (actual === undefined) {
      return {
        manager: this.kind,
        state: "not_installed",
        enabled: false,
        definitionPath,
        drift: ["definition_missing"]
      };
    }

    const disabled = await this.#disabled(label);
    const printed = await this.#print(label);
    const parsed = printed.exitCode === 0 ? parseLaunchdPrint(printed.stdout) : {};
    return {
      manager: this.kind,
      state: printed.exitCode === 0 ? launchdState(parsed.state, parsed.lastExitCode) : "stopped",
      enabled: !disabled,
      pid: parsed.pid,
      lastExitCode: parsed.lastExitCode,
      definitionPath,
      drift: definitionDrift(actual, renderLaunchdPlistNormalized(normalized, label))
    };
  }

  /**
   * Leave the LaunchAgent plist and disabled override matching `spec`.
   * A stopped job stays stopped; a loaded job is reloaded only when plist content changed.
   */
  async install(spec: ServiceSpec): Promise<void> {
    const normalized = this.#normalize(spec);
    const label = launchdLabel(normalized);
    const definitionPath = this.#definitionPath(label);
    await ensureOutputDirectories(normalized);
    // Remember whether launchd already owns an instance. This lets a changed
    // definition take effect without turning install into an implicit first start.
    const wasLoaded = (await this.#print(label)).exitCode === 0;
    const changed = await writeDefinition(
      definitionPath,
      renderLaunchdPlistNormalized(normalized, label)
    );
    await this.#setEnabled(label, normalized.enabled);
    if (changed && wasLoaded) {
      // launchd does not reload changed plist bytes in place. Replace a loaded
      // job, but keep it unloaded when the desired definition is disabled.
      await this.#bootout(label);
      if (normalized.enabled) await this.#bootstrap(definitionPath);
    }
  }

  /** Finish with no loaded LaunchAgent and no plist; Runtime home data remains untouched. */
  async uninstall(spec: ServiceSpec): Promise<void> {
    const normalized = this.#normalize(spec);
    const label = launchdLabel(normalized);
    await this.#bootout(label);
    await removeDefinition(this.#definitionPath(label));
  }

  /** Clear launchd's disabled override; this affects future activation but does not bootstrap now. */
  async enable(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    await this.#setEnabled(launchdLabel(normalized), true);
  }

  /** Set launchd's disabled override; an already loaded process is deliberately left running. */
  async disable(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    await this.#setEnabled(launchdLabel(normalized), false);
  }

  /** Finish with the job loaded/started by launchd, without claiming daemon IPC readiness. */
  async start(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    const label = launchdLabel(normalized);
    if (await this.#disabled(label)) {
      throw new ServiceError(
        "SERVICE_DISABLED",
        "launchd service is disabled; call enable before start",
        { backend: this.kind }
      );
    }
    const printed = await this.#print(label);
    const state = printed.exitCode === 0 ? parseLaunchdPrint(printed.stdout).state : undefined;
    if (state === "running") return;
    if (printed.exitCode === 0) {
      await runCommand(
        this.#runner,
        this.kind,
        this.#launchctl,
        ["kickstart", this.#target(label)],
        { env: this.#environment }
      );
    } else {
      await this.#bootstrap(this.#definitionPath(label));
    }
  }

  /** Finish with the job absent from the user's launchd domain; the plist remains installed. */
  async stop(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    await this.#bootout(launchdLabel(normalized));
  }

  /** Finish with a newly kicked/bootstrapped process, while leaving identity and data files unchanged. */
  async restart(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    const label = launchdLabel(normalized);
    if (await this.#disabled(label)) {
      throw new ServiceError(
        "SERVICE_DISABLED",
        "launchd service is disabled; call enable before restart",
        { backend: this.kind }
      );
    }
    if ((await this.#print(label)).exitCode === 0) {
      await runCommand(
        this.#runner,
        this.kind,
        this.#launchctl,
        ["kickstart", "-k", this.#target(label)],
        { env: this.#environment }
      );
    } else {
      await this.#bootstrap(this.#definitionPath(label));
    }
  }

  #normalize(spec: ServiceSpec): NormalizedServiceSpec {
    if (this.#platform !== "darwin")
      throw new ServiceError("UNSUPPORTED_PLATFORM", "launchd backend requires macOS");
    if (this.#uid < 0 || !this.#homeDirectory)
      throw new ServiceError("MANAGER_UNAVAILABLE", "current user home or uid is unavailable");
    return normalizeServiceSpec(spec, "darwin");
  }

  async #installed(spec: ServiceSpec): Promise<NormalizedServiceSpec> {
    const normalized = this.#normalize(spec);
    if ((await readDefinition(this.#definitionPath(launchdLabel(normalized)))) === undefined) {
      throw new ServiceError("NOT_INSTALLED", "launchd service is not installed", {
        backend: this.kind
      });
    }
    return normalized;
  }

  #definitionPath(label: string): string {
    return join(this.#homeDirectory, "Library", "LaunchAgents", `${label}.plist`);
  }

  #domain(): string {
    return `gui/${this.#uid}`;
  }
  #target(label: string): string {
    return `${this.#domain()}/${label}`;
  }

  #print(label: string) {
    return runCommand(this.#runner, this.kind, this.#launchctl, ["print", this.#target(label)], {
      checked: false,
      env: this.#environment
    });
  }

  async #disabled(label: string): Promise<boolean> {
    const result = await runCommand(
      this.#runner,
      this.kind,
      this.#launchctl,
      ["print-disabled", this.#domain()],
      {
        checked: false,
        env: this.#environment
      }
    );
    if (result.exitCode !== 0) return false;
    const match = result.stdout.match(
      new RegExp(`["']?${escapeRegExp(label)}["']?\\s*=>\\s*(true|false)`)
    );
    return match?.[1] === "true";
  }

  #setEnabled(label: string, enabled: boolean): Promise<unknown> {
    return runCommand(
      this.#runner,
      this.kind,
      this.#launchctl,
      [enabled ? "enable" : "disable", this.#target(label)],
      {
        env: this.#environment
      }
    );
  }

  #bootstrap(definitionPath: string): Promise<unknown> {
    return runCommand(
      this.#runner,
      this.kind,
      this.#launchctl,
      ["bootstrap", this.#domain(), definitionPath],
      {
        env: this.#environment
      }
    );
  }

  async #bootout(label: string): Promise<void> {
    if ((await this.#print(label)).exitCode !== 0) return;
    await runCommand(this.#runner, this.kind, this.#launchctl, ["bootout", this.#target(label)], {
      env: this.#environment
    });
  }
}

/** Validate and render the deterministic LaunchAgent plist for a portable spec. */
export function renderLaunchdPlist(spec: ServiceSpec): string {
  const normalized = normalizeServiceSpec(spec, "darwin");
  return renderLaunchdPlistNormalized(normalized, launchdLabel(normalized));
}

function renderLaunchdPlistNormalized(spec: NormalizedServiceSpec, label: string): string {
  const programArguments = [spec.command, ...spec.args]
    .map((value) => `      <string>${escapeXml(value)}</string>`)
    .join("\n");
  const environment = Object.entries(spec.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`
    )
    .join("\n");
  const keepAlive =
    spec.restart.policy === "always"
      ? "    <true/>"
      : spec.restart.policy === "on-failure"
        ? "    <dict>\n      <key>SuccessfulExit</key>\n      <false/>\n    </dict>"
        : "    <false/>";
  // RunAtLoad expresses autostart in the plist; launchctl's per-user disabled
  // override is the authoritative switch used by enable/disable.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(spec.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
${keepAlive}
  <key>ThrottleInterval</key>
  <integer>${spec.restart.delaySeconds}</integer>
  <key>ExitTimeOut</key>
  <integer>${spec.timeoutStopSeconds}</integer>
  <key>ProcessType</key>
  <string>Background</string>
${environment ? `  <key>EnvironmentVariables</key>\n  <dict>\n${environment}\n  </dict>\n` : ""}${spec.stdoutPath ? `  <key>StandardOutPath</key>\n  <string>${escapeXml(spec.stdoutPath)}</string>\n` : ""}${spec.stderrPath ? `  <key>StandardErrorPath</key>\n  <string>${escapeXml(spec.stderrPath)}</string>\n` : ""}</dict>
</plist>
`;
}

function launchdLabel(spec: NormalizedServiceSpec): string {
  const label = spec.names.launchdLabel ?? spec.id;
  if (!LABEL.test(label)) throw new ServiceError("INVALID_SPEC", "invalid launchd label");
  return label;
}

function parseLaunchdPrint(output: string): {
  state?: string;
  pid?: number;
  lastExitCode?: number;
} {
  const state = output.match(/^\s*state\s*=\s*([^\r\n]+)$/m)?.[1]?.trim();
  const pid = parseOptionalInt(output.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1]);
  const lastExitCode = parseOptionalInt(output.match(/^\s*last exit code\s*=\s*(-?\d+)$/m)?.[1]);
  return { state, pid, lastExitCode };
}

function launchdState(state: string | undefined, lastExitCode: number | undefined): ServiceState {
  if (state === "running") return "running";
  if (state === "spawn scheduled" || state === "starting") return "starting";
  if (state === "stopping") return "stopping";
  if (lastExitCode !== undefined && lastExitCode !== 0) return "failed";
  if (state === "waiting" || state === "exited") return "stopped";
  return "unknown";
}

async function ensureOutputDirectories(spec: NormalizedServiceSpec): Promise<void> {
  for (const path of [spec.stdoutPath, spec.stderrPath]) {
    if (path) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
