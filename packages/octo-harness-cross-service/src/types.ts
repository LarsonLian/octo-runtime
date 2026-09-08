/**
 * Runtime-neutral contracts for managing one long-lived process with the
 * current operating-system user's native service manager.
 *
 * The package deliberately models user services only. A backend never elevates
 * privileges and a {@link ServiceSpec} must never carry enrollment credentials.
 */

/** Native user-service implementation selected for the current platform. */
export type ServiceBackendKind = "launchd-user" | "systemd-user" | "windows-user-task";

/** Manager-level process state. This does not imply daemon IPC or cloud readiness. */
export type ServiceState =
  | "not_installed"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "failed"
  | "unknown";

/** Portable restart modes accepted by the service contract. */
export type ServiceRestartPolicy = "always" | "on-failure" | "never";

/** Portable restart intent; a backend rejects policies it cannot represent faithfully. */
export interface ServiceRestartSpec {
  /** When the native manager should create a replacement process. */
  policy: ServiceRestartPolicy;
  /** Minimum delay before a restart attempt. Defaults to 5 seconds. */
  delaySeconds?: number;
  /** Maximum restart burst accepted by managers that expose rate limiting. Defaults to 5. */
  maxBurst?: number;
}

/** Optional stable native names used instead of names derived from {@link ServiceSpec.id}. */
export interface ServicePlatformNames {
  /** launchd job label, without a file extension. */
  launchdLabel?: string;
  /** systemd user unit name, including the `.service` suffix. */
  systemdUnit?: string;
  /** Root Task Scheduler name, for example `\\OctoHarness.daemon`. */
  windowsTaskName?: string;
}

/**
 * Desired portable definition of one user-owned background process.
 *
 * `command`, `args`, and `environment` become persistent native service
 * configuration. Callers must pass only stable, non-sensitive values and let
 * the daemon read credentials from its protected home at runtime.
 */
export interface ServiceSpec {
  /** Stable logical identifier. It is not a display label or a credential. */
  id: string;
  /** Human-readable native service description. */
  description?: string;
  /** Absolute path to the stable Octo Harness wrapper. */
  command: string;
  /** Exact argv passed to command. No shell parsing is performed. */
  args?: readonly string[];
  /** Absolute working directory visible to the service account. */
  workingDirectory: string;
  /** Non-sensitive values only. Windows user tasks do not support this field. */
  environment?: Readonly<Record<string, string>>;
  /** Native stdout/stderr capture where supported. The daemon remains responsible for application logs. */
  stdoutPath?: string;
  /** Native stderr capture path where supported. */
  stderrPath?: string;
  /** Whether the definition should start automatically for the user. Defaults to true. */
  enabled?: boolean;
  /** Native restart behavior. Defaults to `on-failure` with bounded retries. */
  restart?: ServiceRestartSpec;
  /** Grace period exposed to managers that support stop timeouts. Defaults to 45 seconds. */
  timeoutStopSeconds?: number;
  /** Explicit native identifiers; normally the portable `id` is sufficient. */
  names?: ServicePlatformNames;
}

/** Result of checking whether a backend can operate in the current user session. */
export interface ServiceProbe {
  /** Whether the required native manager and user context are available. */
  supported: boolean;
  /** Backend that performed the probe, including when unsupported. */
  manager: ServiceBackendKind;
  /** Bounded diagnostic intended for doctor output, never a credential. */
  detail?: string;
}

/** Snapshot of native service definition and process state. */
export interface ServiceStatus {
  /** Backend that produced the snapshot. */
  manager: ServiceBackendKind;
  /** Native manager state only; consumers must check IPC/cloud readiness separately. */
  state: ServiceState;
  /** Whether the native definition is configured for user login/boot activation. */
  enabled: boolean;
  /** Manager-reported main process ID when available. */
  pid?: number;
  /** Most recent native process exit code when available. */
  lastExitCode?: number;
  /** Absolute path of the managed plist, unit, or Task Scheduler XML sidecar. */
  definitionPath?: string;
  /** Stable drift identifiers comparing desired and installed definitions. */
  drift: string[];
  /** Bounded manager diagnostic when a complete snapshot cannot be produced. */
  detail?: string;
}

/**
 * Common lifecycle contract implemented by every native user-service backend.
 *
 * Lifecycle methods operate only on an already installed definition unless the
 * method is explicitly {@link ServiceBackend.install}. None of them waits for
 * application IPC or cloud readiness; the CLI owns those higher-level checks.
 * A successful native operation therefore means "the OS manager accepted and
 * reached the requested manager state", not "Octo Harness is ready online".
 */
export interface ServiceBackend {
  /** Stable backend discriminator. */
  readonly kind: ServiceBackendKind;
  /** Return whether this user can use the expected native manager, without changing any state. */
  probe(): Promise<ServiceProbe>;
  /** Return the installed/enabled/process snapshot and drift IDs, without repairing anything. */
  inspect(spec: ServiceSpec): Promise<ServiceStatus>;
  /**
   * Make the native definition and autostart setting match `spec`.
   * A previously stopped service stays stopped; a running service is replaced
   * only when a changed definition must take effect.
   */
  install(spec: ServiceSpec): Promise<void>;
  /**
   * Leave no native job/task or managed definition behind.
   * The managed process is stopped, while Harness credentials, databases, and logs are preserved.
   */
  uninstall(spec: ServiceSpec): Promise<void>;
  /** Configure an installed definition to start on the user's next login/manager activation; current process is unchanged. */
  enable(spec: ServiceSpec): Promise<void>;
  /** Prevent future login/manager activation; an already running process keeps running. */
  disable(spec: ServiceSpec): Promise<void>;
  /**
   * Ensure the native manager has started the installed definition.
   * Success does not prove that the daemon IPC socket or cloud Runtime is ready.
   */
  start(spec: ServiceSpec): Promise<void>;
  /** Ensure the native manager no longer has a running instance; already stopped is a successful no-op. */
  stop(spec: ServiceSpec): Promise<void>;
  /**
   * Ensure the manager has launched a replacement process (or started one if stopped).
   * Success still requires a separate IPC readiness check by the caller.
   */
  restart(spec: ServiceSpec): Promise<void>;
}

/** Process-execution controls used by {@link CommandRunner}. */
export interface CommandOptions {
  /** Child working directory; normally omitted for native manager commands. */
  cwd?: string;
  /** Exact child environment. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this duration; zero disables the timeout. */
  timeoutMs?: number;
}

/** Captured result of one native manager command. */
export interface CommandResult {
  /** Executable passed to the process launcher. */
  command: string;
  /** Exact argv passed without shell interpretation. */
  args: readonly string[];
  /** Numeric exit code; the default runner uses 124 for a timeout. */
  exitCode: number;
  /** Bounded tail of standard output. */
  stdout: string;
  /** Bounded tail of standard error. */
  stderr: string;
}

/** Injectable shell-free process runner used by all service backends. */
export interface CommandRunner {
  /** Execute one command with an exact argv array and return its captured result. */
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

/**
 * Backend construction options. Platform paths and identity fields are exposed
 * primarily for hermetic tests and controlled packaging environments.
 */
export interface ServiceBackendOptions {
  /** Platform override; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Command executor override; defaults to {@link NodeCommandRunner}. */
  runner?: CommandRunner;
  /** Current OS user's home/profile directory. */
  homeDirectory?: string;
  /** Environment inherited by native manager commands. */
  environment?: NodeJS.ProcessEnv;
  /** macOS user id used to address the `gui/<uid>` launchd domain. */
  uid?: number;
  /** Windows account identity used by the task principal and logon trigger. */
  windowsUserId?: string;
  /** Absolute/custom launchctl executable path. */
  launchctlPath?: string;
  /** Absolute/custom systemctl executable path. */
  systemctlPath?: string;
  /** Absolute/custom schtasks executable path. */
  schtasksPath?: string;
  /** Absolute/custom Windows PowerShell executable path. */
  powershellPath?: string;
  /** Directory retaining desired Task Scheduler XML for drift inspection. */
  windowsDefinitionDirectory?: string;
}

/** Validated, defaulted, immutable form consumed by platform renderers. */
export interface NormalizedServiceSpec {
  /** Validated portable identifier. */
  id: string;
  /** Non-empty description, defaulted from `id`. */
  description: string;
  /** Validated absolute executable path. */
  command: string;
  /** Frozen, credential-free argv. */
  args: readonly string[];
  /** Validated absolute working directory. */
  workingDirectory: string;
  /** Frozen, credential-free environment. */
  environment: Readonly<Record<string, string>>;
  /** Optional validated native stdout path. */
  stdoutPath?: string;
  /** Optional validated native stderr path. */
  stderrPath?: string;
  /** Resolved autostart state. */
  enabled: boolean;
  /** Restart settings with all defaults applied. */
  restart: Required<ServiceRestartSpec>;
  /** Resolved stop timeout in seconds. */
  timeoutStopSeconds: number;
  /** Frozen platform-specific naming overrides. */
  names: ServicePlatformNames;
}
