/** Structured failures shared by all native service backends. */
import type { ServiceBackendKind } from "./types.js";

/** Stable category suitable for CLI exit-code and remediation mapping. */
export type ServiceErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_SPEC"
  | "UNSUPPORTED_SPEC"
  | "MANAGER_UNAVAILABLE"
  | "NOT_INSTALLED"
  | "SERVICE_DISABLED"
  | "COMMAND_FAILED";

/** Optional native-manager context attached to a {@link ServiceError}. */
export interface ServiceErrorOptions {
  /** Backend that produced the failure, when selection already succeeded. */
  backend?: ServiceBackendKind;
  /** Native manager executable involved; argv is intentionally not retained. */
  command?: string;
  /** Native command exit code when a child process was started. */
  exitCode?: number;
  /** Bounded stderr/stdout tail safe for diagnostics. */
  detail?: string;
  /** Original error retained through the standard `Error.cause` chain. */
  cause?: unknown;
}

/** Error carrying a stable code plus bounded native-manager diagnostics. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly backend?: ServiceBackendKind;
  readonly command?: string;
  readonly exitCode?: number;
  readonly detail?: string;

  /** Create an error without persisting command arguments or service credentials. */
  constructor(code: ServiceErrorCode, message: string, options: ServiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ServiceError";
    this.code = code;
    this.backend = options.backend;
    this.command = options.command;
    this.exitCode = options.exitCode;
    this.detail = options.detail;
  }
}
