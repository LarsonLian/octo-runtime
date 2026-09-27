import type { EmbeddedProblem } from "./types.js";

export class EmbeddedHarnessError extends Error {
  constructor(
    readonly code: string,
    readonly scope: EmbeddedProblem["scope"],
    readonly retryable: boolean,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "EmbeddedHarnessError";
  }
}

export function asEmbeddedError(
  error: unknown,
  fallback: Pick<EmbeddedProblem, "code" | "scope" | "retryable">
): EmbeddedHarnessError {
  if (error instanceof EmbeddedHarnessError) return error;
  return new EmbeddedHarnessError(
    fallback.code,
    fallback.scope,
    fallback.retryable,
    error instanceof Error ? error.message : String(error),
    error instanceof Error ? { cause: error } : undefined
  );
}
