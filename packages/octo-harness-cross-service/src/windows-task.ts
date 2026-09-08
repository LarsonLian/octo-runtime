/** Windows current-user service backend implemented with Task Scheduler. */
import { join, win32 } from "node:path";
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
  CommandResult,
  CommandRunner,
  NormalizedServiceSpec,
  ServiceBackend,
  ServiceBackendOptions,
  ServiceProbe,
  ServiceSpec,
  ServiceState,
  ServiceStatus
} from "./types.js";

const WINDOWS_TASK_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;
const TASK_RESTART_MINIMUM_SECONDS = 60;

interface WindowsTaskQuery {
  state?: string;
  enabled?: boolean;
  last_exit_code?: number;
  execute?: string;
  arguments?: string;
  working_directory?: string;
  principal_user_id?: string;
  principal_logon_type?: string;
  trigger_user_id?: string;
}

/**
 * Manage a least-privilege Task Scheduler task for the current Windows user.
 *
 * The task uses an `InteractiveToken` principal and a logon trigger, so it runs
 * while that user is signed in (including while the session is locked). It is
 * intentionally not a Windows SCM service and does not run before user logon.
 * Desired XML is retained as a protected sidecar for deterministic drift checks.
 */
export class WindowsUserTaskBackend implements ServiceBackend {
  readonly kind = "windows-user-task" as const;
  readonly #platform: NodeJS.Platform;
  readonly #runner: CommandRunner;
  readonly #homeDirectory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #windowsUserId: string;
  readonly #schtasks: string;
  readonly #powershell: string;
  readonly #definitionDirectory: string;

  /** Build a backend for the current Windows user, with injectable dependencies for tests. */
  constructor(options: ServiceBackendOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#runner = options.runner ?? new NodeCommandRunner();
    this.#homeDirectory = options.homeDirectory ?? process.env.USERPROFILE ?? "";
    this.#environment = options.environment ?? process.env;
    this.#windowsUserId = options.windowsUserId ?? windowsUserId(this.#environment);
    const windowsDirectory = this.#environment.SystemRoot ?? this.#environment.WINDIR ?? "C:\\Windows";
    this.#schtasks = options.schtasksPath ?? win32.join(windowsDirectory, "System32", "schtasks.exe");
    this.#powershell = options.powershellPath
      ?? win32.join(windowsDirectory, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const localAppData = this.#environment.LOCALAPPDATA
      ?? win32.join(this.#homeDirectory, "AppData", "Local");
    this.#definitionDirectory = options.windowsDefinitionDirectory
      ?? win32.join(localAppData, "OctoHarness", "services");
  }

  /** Report whether Task Scheduler and query cmdlets work for this user; no task is created. */
  async probe(): Promise<ServiceProbe> {
    if (this.#platform !== "win32") return { supported: false, manager: this.kind, detail: "requires Windows" };
    if (!this.#homeDirectory || !this.#windowsUserId) {
      return { supported: false, manager: this.kind, detail: "current Windows user or profile is unavailable" };
    }
    try {
      const scheduler = await runCommand(this.#runner, this.kind, this.#schtasks, ["/Query", "/FO", "CSV", "/NH"], {
        checked: false,
        env: this.#environment
      });
      if (scheduler.exitCode !== 0) {
        return {
          supported: false,
          manager: this.kind,
          detail: (scheduler.stderr || scheduler.stdout).trim() || "Task Scheduler is unavailable"
        };
      }
      await runCommand(this.#runner, this.kind, this.#powershell, powershellArguments("Get-Command Get-ScheduledTask -ErrorAction Stop | Out-Null"), {
        env: this.#environment
      });
      return { supported: true, manager: this.kind };
    } catch (error) {
      return { supported: false, manager: this.kind, detail: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Return live scheduler state and exact drift from the desired XML/principal/action. */
  async inspect(spec: ServiceSpec): Promise<ServiceStatus> {
    const normalized = this.#normalize(spec);
    const taskName = windowsTaskName(normalized);
    const definitionPath = this.#definitionPath(normalized);
    const desired = renderWindowsTaskXmlNormalized(normalized, taskName, this.#windowsUserId);
    const actual = await readDefinition(definitionPath);
    const exists = await this.#exists(taskName);
    if (!exists) {
      return {
        manager: this.kind,
        state: "not_installed",
        enabled: false,
        definitionPath,
        drift: ["manager_definition_missing", ...definitionDrift(actual, desired)]
      };
    }
    const queried = await this.#query(taskName);
    if (queried.exitCode !== 0) {
      return {
        manager: this.kind,
        state: "unknown",
        enabled: false,
        definitionPath,
        drift: definitionDrift(actual, desired),
        detail: (queried.stderr || queried.stdout).trim() || "PowerShell task status query failed"
      };
    }

    let task: WindowsTaskQuery;
    try {
      task = JSON.parse(queried.stdout) as WindowsTaskQuery;
    } catch {
      return {
        manager: this.kind,
        state: "unknown",
        enabled: false,
        definitionPath,
        drift: definitionDrift(actual, desired),
        detail: "PowerShell returned an invalid task status payload"
      };
    }
    return {
      manager: this.kind,
      state: windowsTaskState(task.state),
      enabled: task.enabled === true,
      lastExitCode: task.last_exit_code,
      definitionPath,
      drift: [...definitionDrift(actual, desired), ...windowsManagerDrift(task, normalized, this.#windowsUserId)],
      detail: task.state ? undefined : "Task Scheduler did not report a state"
    };
  }

  /**
   * Leave the registered task and enabled setting matching `spec`.
   * A stopped task stays stopped; a previously running task is relaunched only
   * when the reconciled task remains enabled.
   */
  async install(spec: ServiceSpec): Promise<void> {
    const normalized = this.#normalize(spec);
    const taskName = windowsTaskName(normalized);
    const definitionPath = this.#definitionPath(normalized);
    // Re-registration replaces Task Scheduler's definition. Capture running
    // state first so install can restore it without becoming an implicit start.
    const previous = await this.inspect(spec);
    await writeDefinition(definitionPath, renderWindowsTaskXmlNormalized(normalized, taskName, this.#windowsUserId));
    if (previous.state === "running") {
      await this.#schtasksCommand(["/End", "/TN", taskName], false);
    }
    await this.#schtasksCommand(["/Create", "/TN", taskName, "/XML", definitionPath, "/F"]);
    // Restore only a previously running enabled task. A stopped task remains
    // stopped, so setup controls the explicit first start and readiness wait.
    if (previous.state === "running" && normalized.enabled) {
      await this.#schtasksCommand(["/Run", "/TN", taskName]);
    }
  }

  /** Finish with no scheduled task or XML sidecar; Harness credentials and data remain. */
  async uninstall(spec: ServiceSpec): Promise<void> {
    const normalized = this.#normalize(spec);
    const taskName = windowsTaskName(normalized);
    await this.#schtasksCommand(["/End", "/TN", taskName], false);
    await this.#schtasksCommand(["/Delete", "/TN", taskName, "/F"], false);
    await removeDefinition(this.#definitionPath(normalized));
  }

  /** Enable future logon/on-demand activation; do not launch the task now. */
  async enable(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    await this.#schtasksCommand(["/Change", "/TN", windowsTaskName(normalized), "/ENABLE"]);
  }

  /** Prevent future activation; an already running process is deliberately left running. */
  async disable(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    await this.#schtasksCommand(["/Change", "/TN", windowsTaskName(normalized), "/DISABLE"]);
  }

  /** Finish with Task Scheduler reporting a running/queued task, then let the CLI verify IPC. */
  async start(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    const status = await this.inspect(spec);
    if (status.detail) {
      throw new ServiceError("MANAGER_UNAVAILABLE", status.detail, { backend: this.kind });
    }
    if (!status.enabled) {
      throw new ServiceError("SERVICE_DISABLED", "Windows task is disabled; call enable before start", { backend: this.kind });
    }
    if (status.state !== "running") {
      await this.#schtasksCommand(["/Run", "/TN", windowsTaskName(normalized)]);
    }
  }

  /** Finish with no running task instance; keep the registered task and its logon trigger. */
  async stop(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    await this.#schtasksCommand(["/End", "/TN", windowsTaskName(normalized)], false);
  }

  /** Finish with a replacement task process; it continues through screen lock but not user sign-out. */
  async restart(spec: ServiceSpec): Promise<void> {
    const normalized = await this.#installed(spec);
    const status = await this.inspect(spec);
    if (status.detail) {
      throw new ServiceError("MANAGER_UNAVAILABLE", status.detail, { backend: this.kind });
    }
    if (!status.enabled) {
      throw new ServiceError("SERVICE_DISABLED", "Windows task is disabled; call enable before restart", { backend: this.kind });
    }
    await this.#schtasksCommand(["/End", "/TN", windowsTaskName(normalized)], false);
    await this.#schtasksCommand(["/Run", "/TN", windowsTaskName(normalized)]);
  }

  #normalize(spec: ServiceSpec): NormalizedServiceSpec {
    if (this.#platform !== "win32") throw new ServiceError("UNSUPPORTED_PLATFORM", "Windows task backend requires Windows");
    if (!this.#homeDirectory || !this.#windowsUserId) {
      throw new ServiceError("MANAGER_UNAVAILABLE", "current Windows user or profile is unavailable");
    }
    assertSingleLine(this.#windowsUserId, "Windows user id");
    const normalized = normalizeServiceSpec(spec, "win32");
    assertWindowsSupported(normalized);
    return normalized;
  }

  async #installed(spec: ServiceSpec): Promise<NormalizedServiceSpec> {
    const normalized = this.#normalize(spec);
    if (!(await this.#exists(windowsTaskName(normalized)))) {
      throw new ServiceError("NOT_INSTALLED", "Windows task is not installed", { backend: this.kind });
    }
    return normalized;
  }

  #definitionPath(spec: NormalizedServiceSpec): string {
    const fileName = `${spec.id}.xml`;
    return this.#definitionDirectory.includes("\\")
      ? win32.join(this.#definitionDirectory, fileName)
      : join(this.#definitionDirectory, fileName);
  }

  #query(taskName: string): Promise<CommandResult> {
    const script = windowsTaskQueryScript(taskName);
    return runCommand(this.#runner, this.kind, this.#powershell, powershellArguments(script), {
      checked: false,
      env: this.#environment
    });
  }

  async #exists(taskName: string): Promise<boolean> {
    const result = await this.#schtasksCommand(["/Query", "/TN", taskName], false);
    return result.exitCode === 0;
  }

  #schtasksCommand(args: readonly string[], checked = true): Promise<CommandResult> {
    return runCommand(this.#runner, this.kind, this.#schtasks, args, {
      checked,
      env: this.#environment
    });
  }
}

/** Validate and render deterministic Task Scheduler XML for one Windows user. */
export function renderWindowsTaskXml(spec: ServiceSpec, userId: string): string {
  assertSingleLine(userId, "Windows user id");
  const normalized = normalizeServiceSpec(spec, "win32");
  assertWindowsSupported(normalized);
  return renderWindowsTaskXmlNormalized(normalized, windowsTaskName(normalized), userId);
}

/**
 * Quote one argv element with the Windows `CommandLineToArgvW` escaping rules.
 * The returned string is suitable for Task Scheduler's single Arguments field.
 */
export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function renderWindowsTaskXmlNormalized(spec: NormalizedServiceSpec, taskName: string, userId: string): string {
  const argumentsText = spec.args.map(quoteWindowsArgument).join(" ");
  const restart = spec.restart.policy === "on-failure"
    ? `    <RestartOnFailure>\n      <Interval>PT${Math.max(TASK_RESTART_MINIMUM_SECONDS, spec.restart.delaySeconds)}S</Interval>\n      <Count>${spec.restart.maxBurst}</Count>\n    </RestartOnFailure>\n`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(spec.description)}</Description>
    <URI>${escapeXml(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>${spec.enabled}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
${restart}  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(spec.command)}</Command>
${argumentsText ? `      <Arguments>${escapeXml(argumentsText)}</Arguments>\n` : ""}      <WorkingDirectory>${escapeXml(spec.workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function windowsTaskName(spec: NormalizedServiceSpec): string {
  const name = spec.names.windowsTaskName ?? `\\OctoHarness.${spec.id}`;
  const segment = name.startsWith("\\") ? name.slice(1) : "";
  if (!WINDOWS_TASK_SEGMENT.test(segment)) {
    throw new ServiceError("INVALID_SPEC", "Windows task name must be a single root task such as \\OctoHarness.daemon");
  }
  return name;
}

function assertWindowsSupported(spec: NormalizedServiceSpec): void {
  if (Object.keys(spec.environment).length > 0) {
    throw new ServiceError("UNSUPPORTED_SPEC", "Windows user tasks do not support service environment variables", {
      backend: "windows-user-task"
    });
  }
  if (spec.stdoutPath || spec.stderrPath) {
    throw new ServiceError("UNSUPPORTED_SPEC", "Windows user tasks do not support native stdout/stderr redirection", {
      backend: "windows-user-task"
    });
  }
  if (spec.restart.policy === "always") {
    throw new ServiceError("UNSUPPORTED_SPEC", "Windows Task Scheduler cannot represent restart policy 'always'", {
      backend: "windows-user-task"
    });
  }
}

function windowsTaskQueryScript(taskName: string): string {
  const task = taskName.slice(1);
  const quotedTask = powershellSingleQuote(task);
  return `$ErrorActionPreference='Stop';$task=Get-ScheduledTask -TaskPath '\\' -TaskName '${quotedTask}';$info=Get-ScheduledTaskInfo -InputObject $task;$action=@($task.Actions)[0];$trigger=@($task.Triggers)[0];[ordered]@{state=[string]$task.State;enabled=([string]$task.State -ne 'Disabled');last_exit_code=[long]$info.LastTaskResult;execute=[string]$action.Execute;arguments=[string]$action.Arguments;working_directory=[string]$action.WorkingDirectory;principal_user_id=[string]$task.Principal.UserId;principal_logon_type=[string]$task.Principal.LogonType;trigger_user_id=[string]$trigger.UserId}|ConvertTo-Json -Compress`;
}

function powershellArguments(script: string): readonly string[] {
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script];
}

function powershellSingleQuote(value: string): string {
  return value.replaceAll("'", "''");
}

function windowsManagerDrift(
  task: WindowsTaskQuery,
  spec: NormalizedServiceSpec,
  userId: string
): string[] {
  const expectedArguments = spec.args.map(quoteWindowsArgument).join(" ");
  const drift: string[] = [];
  if (!equalWindowsPath(task.execute, spec.command)) drift.push("manager.command");
  if ((task.arguments ?? "") !== expectedArguments) drift.push("manager.arguments");
  if (!equalWindowsPath(task.working_directory, spec.workingDirectory)) drift.push("manager.working_directory");
  if (!equalWindowsIdentity(task.principal_user_id, userId)) drift.push("manager.principal_user");
  if (!["interactivetoken", "interactive", "3"].includes(task.principal_logon_type?.toLowerCase() ?? "")) {
    drift.push("manager.logon_type");
  }
  if (!equalWindowsIdentity(task.trigger_user_id, userId)) drift.push("manager.trigger_user");
  if (task.enabled !== spec.enabled) drift.push("manager.enabled");
  return drift;
}

function equalWindowsPath(actual: string | undefined, expected: string): boolean {
  return actual?.replaceAll("/", "\\").toLowerCase() === expected.replaceAll("/", "\\").toLowerCase();
}

function equalWindowsIdentity(actual: string | undefined, expected: string): boolean {
  return actual?.toLowerCase() === expected.toLowerCase();
}

function windowsTaskState(value: string | undefined): ServiceState {
  switch (value?.toLowerCase()) {
    case "running": return "running";
    case "queued": return "starting";
    case "ready":
    case "disabled": return "stopped";
    default: return "unknown";
  }
}

function windowsUserId(environment: NodeJS.ProcessEnv): string {
  const username = environment.USERNAME?.trim() ?? "";
  const domain = environment.USERDOMAIN?.trim() ?? "";
  return domain && username ? `${domain}\\${username}` : username;
}

function assertSingleLine(value: string, field: string): void {
  if (!value.trim() || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new ServiceError("INVALID_SPEC", `${field} must be non-empty and single-line`);
  }
}
