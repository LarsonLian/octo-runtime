import { resolve } from "node:path";
import type { LogLevel, ObservabilityConfiguration, ProviderIoCapture } from "./types.js";

/** Default policy for local logging when no CLI flag or environment override is present. */
export const DEFAULT_OBSERVABILITY_CONFIGURATION: Omit<ObservabilityConfiguration, "directory"> = {
  logLevel: "info",
  fileLog: true,
  verbose: false,
  traceRpc: false,
  captureProviderIo: "off",
  requireProviderCapture: false,
  retentionDays: 14,
  traceRetentionDays: 3,
  crashRetentionDays: 30,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024
};

/** Resolve the adapter-host environment into the daemon's validated policy. */
export function observabilityConfigurationFromEnv(
  env: NodeJS.ProcessEnv,
  fallbackDirectory: string
): ObservabilityConfiguration {
  const verbose = env.OCTO_HARNESS_VERBOSE === "1";
  return {
    directory: resolve(env.OCTO_HARNESS_LOG_DIR ?? fallbackDirectory),
    logLevel: verbose ? "debug" : logLevel(env.OCTO_HARNESS_LOG_LEVEL ?? "info"),
    fileLog: env.OCTO_HARNESS_FILE_LOG !== "0",
    verbose,
    traceRpc: verbose || env.OCTO_HARNESS_TRACE_RPC === "1",
    captureProviderIo: verbose ? "full" : providerCapture(env.OCTO_HARNESS_CAPTURE_PROVIDER_IO ?? "off"),
    requireProviderCapture: env.OCTO_HARNESS_REQUIRE_PROVIDER_CAPTURE === "1",
    retentionDays: positiveInteger(env.OCTO_HARNESS_LOG_RETENTION_DAYS, 14),
    traceRetentionDays: positiveInteger(env.OCTO_HARNESS_TRACE_RETENTION_DAYS, 3),
    crashRetentionDays: positiveInteger(env.OCTO_HARNESS_CRASH_RETENTION_DAYS, 30),
    maxFileBytes: positiveInteger(env.OCTO_HARNESS_LOG_MAX_FILE_BYTES, 64 * 1024 * 1024),
    maxTotalBytes: positiveInteger(env.OCTO_HARNESS_LOG_MAX_TOTAL_BYTES, 1024 * 1024 * 1024)
  };
}

/** Serialize a resolved policy for daemon-to-adapter-host propagation. */
export function observabilityEnvironment(configuration: ObservabilityConfiguration): NodeJS.ProcessEnv {
  return {
    OCTO_HARNESS_LOG_DIR: configuration.directory,
    OCTO_HARNESS_LOG_LEVEL: configuration.logLevel,
    OCTO_HARNESS_FILE_LOG: configuration.fileLog ? "1" : "0",
    OCTO_HARNESS_VERBOSE: configuration.verbose ? "1" : "0",
    OCTO_HARNESS_TRACE_RPC: configuration.traceRpc ? "1" : "0",
    OCTO_HARNESS_CAPTURE_PROVIDER_IO: configuration.captureProviderIo,
    OCTO_HARNESS_REQUIRE_PROVIDER_CAPTURE: configuration.requireProviderCapture ? "1" : "0",
    OCTO_HARNESS_LOG_RETENTION_DAYS: String(configuration.retentionDays),
    OCTO_HARNESS_TRACE_RETENTION_DAYS: String(configuration.traceRetentionDays),
    OCTO_HARNESS_CRASH_RETENTION_DAYS: String(configuration.crashRetentionDays),
    OCTO_HARNESS_LOG_MAX_FILE_BYTES: String(configuration.maxFileBytes),
    OCTO_HARNESS_LOG_MAX_TOTAL_BYTES: String(configuration.maxTotalBytes)
  };
}

function logLevel(value: string): LogLevel {
  if (value === "trace" || value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  throw new Error("OCTO_HARNESS_LOG_LEVEL must be one of: trace, debug, info, warn, error");
}

function providerCapture(value: string): ProviderIoCapture {
  if (value === "off" || value === "input" || value === "full") return value;
  throw new Error("OCTO_HARNESS_CAPTURE_PROVIDER_IO must be one of: off, input, full");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`expected positive integer, received: ${value}`);
  return parsed;
}
