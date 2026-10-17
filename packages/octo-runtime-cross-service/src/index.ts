/**
 * Public entry point for native, current-user service management.
 *
 * Consumers normally call {@link createServiceBackend}; concrete backends and
 * renderers remain exported for diagnostics, tests, and platform packaging.
 */
import { homedir } from "node:os";
import { ServiceError } from "./errors.js";
import { LaunchdUserBackend } from "./launchd.js";
import { NodeCommandRunner } from "./runner.js";
import { SystemdUserBackend } from "./systemd.js";
import type { ServiceBackend, ServiceBackendOptions } from "./types.js";
import { WindowsUserTaskBackend } from "./windows-task.js";

export { ServiceError, type ServiceErrorCode, type ServiceErrorOptions } from "./errors.js";
export { LaunchdUserBackend, renderLaunchdPlist } from "./launchd.js";
export { NodeCommandRunner } from "./runner.js";
export { SystemdUserBackend, renderSystemdUnit } from "./systemd.js";
export {
  WindowsUserTaskBackend,
  quoteWindowsArgument,
  renderWindowsTaskXml
} from "./windows-task.js";
export { normalizeServiceSpec } from "./common.js";
export type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  NormalizedServiceSpec,
  ServiceBackend,
  ServiceBackendKind,
  ServiceBackendOptions,
  ServicePlatformNames,
  ServiceProbe,
  ServiceRestartPolicy,
  ServiceRestartSpec,
  ServiceSpec,
  ServiceState,
  ServiceStatus
} from "./types.js";

/**
 * Create the native user-service backend for `options.platform` or the current
 * process platform.
 *
 * This only selects a backend. It does not probe, install, start, or elevate
 * privileges. Unsupported platforms fail synchronously with
 * `ServiceError("UNSUPPORTED_PLATFORM")`.
 */
export function createServiceBackend(options: ServiceBackendOptions = {}): ServiceBackend {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? new NodeCommandRunner();
  const homeDirectory = options.homeDirectory ?? homedir();
  const shared = { ...options, platform, runner, homeDirectory };
  switch (platform) {
    case "darwin":
      return new LaunchdUserBackend(shared);
    case "linux":
      return new SystemdUserBackend(shared);
    case "win32":
      return new WindowsUserTaskBackend(shared);
    default:
      throw new ServiceError("UNSUPPORTED_PLATFORM", `unsupported service platform: ${platform}`);
  }
}
