import { assertJsonByteLimit } from "./json-size.js";
import type { InvokeInput, InvokeEnvironment } from "./invoke-input.js";

export const INVOKE_REQUEST_MAX_BYTES = 32 * 1024 * 1024;

export function assertInvokeRequestSize(
  input: InvokeInput,
  environment: InvokeEnvironment = {}
): void {
  assertJsonByteLimit(
    {
      input: { ...input },
      ...(environment.executionEnvOverrides
        ? { executionEnvOverrides: environment.executionEnvOverrides }
        : {}),
      ...(environment.streamLimits ? { streamLimits: environment.streamLimits } : {})
    },
    INVOKE_REQUEST_MAX_BYTES,
    "INVOKE_REQUEST_TOO_LARGE"
  );
}
