/** Linux current-user service backend implemented with `systemctl --user`. */
import { mkdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import {
  definitionDrift,
  normalizeServiceSpec,
  parseProperties,
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

const UNIT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}\.service$/;

/**
 * Manage a systemd user unit under the selected user's configuration home.
 *
 * Every manager command is scoped with `--user`. The backend neither writes a
 * system unit nor enables lingering; setup/doctor must report when the user's
 * systemd manager is unavailable after logout.
 */
export class SystemdUserBackend implements ServiceBackend {
  readonly kind = "systemd-user" as const;
  readonly #platform: NodeJS.Platform;
  readonly #runner: CommandRunner;
  readonly #homeDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #systemctl: string;

  /** Build a backend for the current Linux user, with injectable dependencies for tests. */
  constructor(options: ServiceBackendOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? new NodeCommandRunner();
    this.#homeDirectory = options.homeDirectory ?? process.env.HOME ?? "";
    this.#environment = options.environment ?? process.env;
    this.#systemctl = options.systemctlPath ?? "systemctl";
  }

  /** Report whether `systemctl --user` can reach this user's manager; no unit is written. */
  async probe(): Promise<ServiceProbe> {
    if (this.#platform !== "linux") return { supported: false, manager: this.kind, detail: "requires Linux" };
    if (!this.#homeDirectory) return { supported: false, manager: this.kind, detail: "current user home is unavailable" };
    try {
      const result = await runCommand(this.#runner, this.kind, this.#systemctl, ["--user", "show-environment"], {
        checked: false,
        env: this.#environment
      });
      return result.exitCode === 0
        ? { supported: true, manager: this.kind }
        : { supported: false, manager: this.kind, detail: (result.stderr || result.stdout).trim() || "systemd user manager is unavailable" };
    } catch (error) {
      return { supported: false, manager: this.kind, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Return what systemd reports plus whether the installed unit bytes differ from `spec`. */
  async inspect(spec: ServiceSpec): Promise<ServiceStatus> {
    const normalized = this.#normalize(spec);
    const unit = systemdUnit(normalized);
    const definitionPath = this.#definitionPath(unit);
    const actual = await readDefinition(definitionPath);
    if (actual === undefined) {
      return { manager: this.kind, state: "not_installed", enabled: false, definitionPath, drift: ["definition_missing"] };
    }
    const shown = await this.#show(unit);
    if (shown.exitCode !== 0) {
      return {
        manager: this.kind,
        state: "unknown",
        enabled: false,
        definitionPath,
        drift: definitionDrift(actual, renderSystemdUnitNormalized(normalized)),
        detail: (shown.stderr || shown.stdout).trim() || "systemctl show failed"
      };
    }
    const properties = parseProperties(shown.stdout);
    const pid = positiveInt(properties.MainPID);
    const lastExitCode = optionalInt(properties.ExecMainStatus);
    return {
      manager: this.kind,
      state: systemdState(properties.ActiveState, properties.SubState),
      enabled: ["enabled", "enabled-runtime", "linked", "linked-runtime"].includes(properties.UnitFileState ?? ""),
      pid,
      lastExitCode,
      definitionPath,
      drift: definitionDrift(actual, renderSystemdUnitNormalized(normalized))
    };
  }

  /**
   * Leave the unit file and enablement matching `spec`.
   * A stopped unit stays stopped; a running unit restarts only when its definition changed.
   */
  async install(spec: ServiceSpec): Promise<void> {
    const normalized = this.#normalize(spec);
    const unit = systemdUnit(normalized);
    // Preserve the pre-reconcile process state so setup can repair configuration
    // without accidentally starting a daemon the user intentionally stopped.
    const previous = await this.inspect(spec);
    await ensureOutputDirectories(normalized);
    const changed = await writeDefinition(this.#definitionPath(unit), renderSystemdUnitNormalized(normalized));
    // systemd must reload its unit cache before a changed file can be started.
    if (changed) await this.#command(["daemon-reload"]);
    await this.#command([normalized.enabled ? "enable" : "disable", unit]);
    // Apply new bytes to an existing running instance. Never use install as the
    // first start, and never restart when the desired state is disabled.
    if (changed && previous.state === "running" && normalized.enabled) await this.#command(["restart", unit]);
  }

  /** Finish with the unit stopped, disabled, removed, and forgotten by the user manager. */
  async uninstall(spec: ServiceSpec): Promise<void> {
    const normalized = this.#normalize(spec);
    const unit = systemdUnit(normalized);
    await this.#command(["stop", unit], false);
    await this.#command(["disable", unit], false);
    await removeDefinition(this.#definitionPath(unit));
    await this.#command(["daemon-reload"]);
    await this.#command(["reset-failed", unit], false);
  }

  /** Add the default-target link for future user-manager activation; do not start now. */
  async enable(spec: ServiceSpec): Promise<void> {
    const unit = systemdUnit(await this.#installed(spec));
    await this.#command(["enable", unit]);
  }

  /** Remove the default-target link; an already running process is deliberately left running. */
  async disable(spec: ServiceSpec): Promise<void> {
    const unit = systemdUnit(await this.#installed(spec));
    await this.#command(["disable", unit]);
  }

  /** Finish with systemd reporting the unit active/starting, then let the CLI verify daemon readiness. */
  async start(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    const status = await this.inspect(spec);
    if (!status.enabled) {
      throw new ServiceError("SERVICE_DISABLED", "systemd service is disabled; call enable before start", { backend: this.kind });
    }
    if (status.state !== "running") await this.#command(["start", systemdUnit(normalized)]);
  }

  /** Finish with no active process for the installed unit; keep the unit file and enablement. */
  async stop(spec: ServiceSpec): Promise<void> {
    const unit = systemdUnit(await this.#installed(spec));
    await this.#command(["stop", unit]);
  }

  /** Finish with systemd having launched a replacement process; persistent Harness data is unchanged. */
  async restart(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    const status = await this.inspect(spec);
    if (!status.enabled) {
      throw new ServiceError("SERVICE_DISABLED", "systemd service is disabled; call enable before restart", { backend: this.kind });
    }
    await this.#command(["restart", systemdUnit(normalized)]);
  }

  #normalize(spec: ServiceSpec): NormalizedServiceSpec {
    if (this.#platform !== "linux") throw new ServiceError("UNSUPPORTED_PLATFORM", "systemd backend requires Linux");
    if (!this.#homeDirectory) throw new ServiceError("MANAGER_UNAVAILABLE", "current user home is unavailable");
    return normalizeServiceSpec(spec, "linux");
  }

  async #installed(spec: ServiceSpec): Promise<NormalizedServiceSpec> {
    const normalized = this.#normalize(spec);
    if (await readDefinition(this.#definitionPath(systemdUnit(normalized))) === undefined) {
      throw new ServiceError("NOT_INSTALLED", "systemd service is not installed", { backend: this.kind });
    }
    return normalized;
  }

  #definitionPath(unit: string): string {
    const xdg = this.#environment.XDG_CONFIG_HOME;
    const configHome = xdg && posix.isAbsolute(xdg) ? xdg : join(this.#homeDirectory, ".config");
    return join(configHome, "systemd", "user", unit);
  }

  #show(unit: string) {
    return this.#command([
      "show",
      unit,
      "--no-pager",
      "--property=LoadState",
      "--property=UnitFileState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=MainPID",
      "--property=ExecMainStatus"
    ], false);
  }

  #command(args: readonly string[], checked = true) {
    return runCommand(this.#runner, this.kind, this.#systemctl, ["--user", ...args], {
      checked,
      env: this.#environment
    });
  }
}

/** Validate and render the deterministic systemd user unit for a portable spec. */
export function renderSystemdUnit(spec: ServiceSpec): string {
  return renderSystemdUnitNormalized(normalizeServiceSpec(spec, "linux"));
}

function renderSystemdUnitNormalized(spec: NormalizedServiceSpec): string {
  const restart = spec.restart.policy === "never" ? "no" : spec.restart.policy;
  const environment = Object.entries(spec.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  const output = spec.stdoutPath ? `StandardOutput=${systemdQuote(`append:${spec.stdoutPath}`)}\n` : "";
  const error = spec.stderrPath ? `StandardError=${systemdQuote(`append:${spec.stderrPath}`)}\n` : "";
  return `[Unit]
Description=${escapeSystemdText(spec.description)}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=${spec.restart.maxBurst}

[Service]
Type=simple
ExecStart=:${[spec.command, ...spec.args].map(systemdQuote).join(" ")}
WorkingDirectory=${systemdQuote(spec.workingDirectory)}
${environment ? `${environment}\n` : ""}Restart=${restart}
RestartSec=${spec.restart.delaySeconds}s
TimeoutStopSec=${spec.timeoutStopSeconds}s
${output}${error}
[Install]
WantedBy=default.target
`;
}

function systemdUnit(spec: NormalizedServiceSpec): string {
  const configured = spec.names.systemdUnit;
  const unit = configured ?? `${spec.id}.service`;
  if (!UNIT_NAME.test(unit)) throw new ServiceError("INVALID_SPEC", "invalid systemd unit name");
  return unit;
}

function systemdQuote(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")}"`;
}

function escapeSystemdText(value: string): string {
  return value.replaceAll("%", "%%");
}

function systemdState(active: string | undefined, sub: string | undefined): ServiceState {
  if (active === "active") return "running";
  if (active === "activating") return "starting";
  if (active === "deactivating") return "stopping";
  if (active === "failed") return "failed";
  if (active === "inactive" || sub === "dead" || sub === "exited") return "stopped";
  return "unknown";
}

async function ensureOutputDirectories(spec: NormalizedServiceSpec): Promise<void> {
  for (const path of [spec.stdoutPath, spec.stderrPath]) {
    if (path) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
}

function optionalInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = optionalInt(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}
