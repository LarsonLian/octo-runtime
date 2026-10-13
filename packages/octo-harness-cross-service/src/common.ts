/** Shared validation, atomic file I/O, and manager-command error translation. */
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, posix, win32 } from "node:path";
import { ServiceError } from "./errors.js";
import type {
  CommandResult,
  CommandRunner,
  NormalizedServiceSpec,
  ServiceBackendKind,
  ServiceSpec
} from "./types.js";

const SERVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SENSITIVE_ENVIRONMENT_KEY =
  /(^|_)(authorization|cookie|credential|password|private_key|secret|token|api_key|access_key)($|_)/i;
const SENSITIVE_ARGUMENT =
  /(^|\s)(bearer\s+|octo_enroll_)|^--?(?:auth(?:orization)?|.*(?:token|secret|password|private-key|api-key))(?:=|$)/i;

/**
 * Validate a portable spec, reject obvious credential persistence, apply
 * defaults, and freeze collection fields before platform rendering.
 */
export function normalizeServiceSpec(
  spec: ServiceSpec,
  platform: NodeJS.Platform
): NormalizedServiceSpec {
  if (!SERVICE_ID.test(spec.id))
    invalid("id must contain only letters, digits, dot, underscore, or hyphen");
  assertText(spec.command, "command");
  assertText(spec.workingDirectory, "workingDirectory");
  if (spec.description !== undefined) assertText(spec.description, "description");
  if (!isAbsoluteForPlatform(spec.command, platform)) invalid("command must be an absolute path");
  if (!isAbsoluteForPlatform(spec.workingDirectory, platform))
    invalid("workingDirectory must be an absolute path");

  const args = [...(spec.args ?? [])];
  for (const arg of args) {
    assertTextAllowEmpty(arg, "args");
    if (SENSITIVE_ARGUMENT.test(arg))
      invalid("service args must not contain credentials or credential flags");
  }

  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.environment ?? {})) {
    if (!ENVIRONMENT_KEY.test(key)) invalid(`invalid environment key: ${key}`);
    if (SENSITIVE_ENVIRONMENT_KEY.test(key))
      invalid(`sensitive environment key is not allowed: ${key}`);
    assertTextAllowEmpty(value, `environment.${key}`);
    environment[key] = value;
  }

  for (const [key, value] of [
    ["stdoutPath", spec.stdoutPath],
    ["stderrPath", spec.stderrPath]
  ] as const) {
    if (value === undefined) continue;
    assertText(value, key);
    if (!isAbsoluteForPlatform(value, platform)) invalid(`${key} must be an absolute path`);
  }

  const delaySeconds = integerInRange(
    spec.restart?.delaySeconds ?? 5,
    1,
    3600,
    "restart.delaySeconds"
  );
  const maxBurst = integerInRange(spec.restart?.maxBurst ?? 5, 1, 100, "restart.maxBurst");
  const timeoutStopSeconds = integerInRange(
    spec.timeoutStopSeconds ?? 45,
    1,
    3600,
    "timeoutStopSeconds"
  );
  const policy = spec.restart?.policy ?? "on-failure";
  if (!(["always", "on-failure", "never"] as const).includes(policy))
    invalid("invalid restart.policy");
  if (spec.enabled !== undefined && typeof spec.enabled !== "boolean")
    invalid("enabled must be a boolean");
  return Object.freeze({
    id: spec.id,
    description: spec.description?.trim() || `Octo Harness service ${spec.id}`,
    command: spec.command,
    args: Object.freeze(args),
    workingDirectory: spec.workingDirectory,
    environment: Object.freeze(environment),
    stdoutPath: spec.stdoutPath,
    stderrPath: spec.stderrPath,
    enabled: spec.enabled ?? true,
    restart: Object.freeze({
      policy,
      delaySeconds,
      maxBurst
    }),
    timeoutStopSeconds,
    names: Object.freeze({ ...(spec.names ?? {}) })
  });
}

/** Apply Windows or POSIX path rules without depending on the host platform. */
export function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? win32.isAbsolute(value) : posix.isAbsolute(value);
}

/** Run one native manager command and translate spawn/exit failures to `ServiceError`. */
export async function runCommand(
  runner: CommandRunner,
  backend: ServiceBackendKind,
  command: string,
  args: readonly string[],
  options: { checked?: boolean; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await runner.run(command, args, { env: options.env, timeoutMs: options.timeoutMs });
  } catch (cause) {
    throw new ServiceError("MANAGER_UNAVAILABLE", `${backend} manager is unavailable`, {
      backend,
      command,
      cause,
      detail: cause instanceof Error ? cause.message : String(cause)
    });
  }
  if ((options.checked ?? true) && result.exitCode !== 0) {
    throw new ServiceError("COMMAND_FAILED", `${backend} command failed`, {
      backend,
      command,
      exitCode: result.exitCode,
      detail: boundedDetail(result.stderr || result.stdout)
    });
  }
  return result;
}

/** Read a UTF-8 service definition; absence is represented as `undefined`. */
export async function readDefinition(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * Atomically replace a service definition with mode 0600.
 * Returns `false` when the installed bytes already match the desired content.
 */
export async function writeDefinition(path: string, content: string): Promise<boolean> {
  if ((await readDefinition(path)) === content) return false;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return true;
}

/** Remove a service definition if present. */
export async function removeDefinition(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Return stable drift identifiers for desired-versus-installed file content. */
export function definitionDrift(actual: string | undefined, desired: string): string[] {
  if (actual === undefined) return ["definition_missing"];
  return actual === desired ? [] : ["definition_content"];
}

/** Escape arbitrary text for XML element content. */
export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Parse newline-separated `key=value` manager output without interpreting values. */
export function parseProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

/** Narrow an unknown error to a Node.js system error with the requested code. */
export function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

function assertText(value: string, field: string): void {
  if (!value || value.includes("\0") || /[\r\n]/.test(value))
    invalid(`${field} must be non-empty and single-line`);
}

function assertTextAllowEmpty(value: string, field: string): void {
  if (value.includes("\0") || /[\r\n]/.test(value))
    invalid(`${field} must not contain NUL or line breaks`);
}

function integerInRange(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function invalid(message: string): never {
  throw new ServiceError("INVALID_SPEC", message);
}

function boundedDetail(value: string): string | undefined {
  const detail = value.trim();
  return detail ? detail.slice(-4096) : undefined;
}
