import type { DaemonProblem } from "./types.js";

export class DaemonRuntimeError extends Error {
  constructor(
    readonly code: string,
    readonly scope: DaemonProblem["scope"],
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "DaemonRuntimeError";
  }
}

export function asDaemonRuntimeError(
  error: unknown,
  fallback: Pick<DaemonProblem, "code" | "scope" | "retryable">
): DaemonRuntimeError {
  if (error instanceof DaemonRuntimeError) return error;
  return new DaemonRuntimeError(
    fallback.code,
    fallback.scope,
    fallback.retryable,
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? { cause: error } : undefined
  );
}
