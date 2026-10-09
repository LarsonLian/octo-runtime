#!/usr/bin/env node
// Standalone adapter-host process: load the adapters listed in a JSON manifest,
// register them into an AdapterHost, then serve invocations over NDJSON JSON-RPC
// on stdio (the daemon-to-host transport). Kept separate from the daemon so
// provider processes are isolated behind a process boundary.
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WatchdogMetrics } from "./watchdog-metrics.js";
import {
  AdapterHost,
  AdapterHostRpcServer,
  type HostedAdapter
} from "./index.js";
import {
  installCrashReporter,
  LocalObservability,
  observabilityConfigurationFromEnv
} from "@mininglamp-oss/octo-harness-observability";

type JsonRecord = Record<string, unknown>;

interface AdapterManifestEntry {
  type?: string;
  module: string;
  exportName: string;
  factory: boolean;
  options: JsonRecord;
}

interface AdapterManifest {
  version: number;
  adapters: AdapterManifestEntry[];
}

const index = process.argv.indexOf("--manifest");
if (index < 0 || !process.argv[index + 1]) throw new Error("usage: octo-harness-adapter-host --manifest <file>");

const logging = observabilityConfigurationFromEnv(
  process.env,
  join(process.env.OCTO_HARNESS_HOME ?? join(homedir(), ".octo-harness"), "logs")
);
const crashReporter = logging.fileLog
  ? installCrashReporter({ directory: logging.directory, component: "adapter-host" })
  : undefined;
const manifestPath = resolve(process.argv[index + 1]);
const rawManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
const manifest = parseManifest(rawManifest);
const observationOutput = createWriteStream("/dev/null", { fd: 3, autoClose: false });
let observationWritable = true;
let observationDrops = 0;
observationOutput.on("drain", () => { observationWritable = true; });
observationOutput.on("error", () => { observationWritable = false; });
const emitObservation = (value: unknown): void => {
  if (!observationWritable) {
    observationDrops += 1;
    return;
  }
  try {
    const line = `${JSON.stringify({ ...(asRecord(value, "observation")), droppedBefore: observationDrops })}\n`;
    if (Buffer.byteLength(line) > 256 * 1024) {
      observationDrops += 1;
      return;
    }
    observationDrops = 0;
    observationWritable = observationOutput.write(line);
  } catch {
    observationDrops += 1;
  }
};
const observability = new LocalObservability(
  { ...logging, component: "adapter-host" },
  { eventSink: record => emitObservation({ source: record.scope === "adapter.watchdog" ? "provider-activity" : "provider-native", record }) }
);
const watchdogMetrics = new WatchdogMetrics();
const publishWatchdogMetrics = (): void => emitObservation({ protocolVersion: 2, source: "control", type: "watchdog.metrics", payload: watchdogMetrics.snapshot() });
const metricsTimer = setInterval(publishWatchdogMetrics, 5000);
metricsTimer.unref();
const host = new AdapterHost({
  observe: (identity, observation) => observability.observeProvider(identity, observation),
  diagnosticSink: (identity, diagnostic) => {
    watchdogMetrics.record(identity.adapterType ?? "other", diagnostic);
    if (diagnostic.event === "timeout" || diagnostic.event === "finished") publishWatchdogMetrics();
    observability.log({
      ...identity,
      level: diagnostic.event === "timeout" || diagnostic.event === "model_silence" ? "warn" : "info",
      scope: "adapter.watchdog", event: `watchdog.${diagnostic.event}`,
      message: "adapter watchdog diagnostic",
      data: { ...diagnostic.data, watchdogVersion: 2 }
    });
  },
  canonicalSink: (identity, event) => emitObservation({ protocolVersion: 2,
    source: "adapter-canonical",
    type: event.type,
    profile: identity.profile,
    runtimeId: identity.runtimeId,
    runId: identity.runId,
    agentSessionId: identity.agentSessionId,
    invocationId: identity.invocationId,
    adapterType: identity.adapterType,
    payload: event
  })
});

for (const entry of manifest.adapters) {
  const specifier = entry.module.startsWith(".") || entry.module.startsWith("/")
    ? pathToFileURL(resolve(dirname(manifestPath), entry.module)).href
    : entry.module;
  const loaded: unknown = await import(specifier);
  const moduleExports = asRecord(loaded, `adapter module ${entry.module}`);
  const exported = moduleExports[entry.exportName];
  if (exported === undefined) {
    throw new Error(`missing export ${entry.exportName} from ${entry.module}`);
  }

  // The manifest is a dynamic plugin boundary: validate the factory and adapter
  // shape before handing the instance to the host for registration.
  const instance: unknown = entry.factory
    ? callFactory(exported, entry.options, entry)
    : exported;
  if (!isHostedAdapter(instance)) {
    throw new TypeError(`${entry.module}#${entry.exportName} is not an Octo Harness adapter`);
  }
  if (entry.type && instance.metadata.type !== entry.type) {
    throw new Error(`manifest type ${entry.type} does not match adapter ${instance.metadata.type}`);
  }
  host.register(instance);
  observability.log({
    level: "info",
    scope: "adapter.registry",
    event: "adapter.registered",
    message: "adapter registered",
    adapterType: instance.metadata.type,
    data: { capabilities: instance.metadata.capabilities, agentSources: instance.metadata.agentSources, executionFeatures: instance.metadata.executionFeatures }
  });
}

new AdapterHostRpcServer({ host, output: process.stdout }).listen(process.stdin);
observability.log({
  level: "info",
  scope: "adapter-host.lifecycle",
  event: "adapter-host.ready",
  message: "adapter host ready",
  data: { manifest_path: manifestPath, adapters: host.list().map(adapter => adapter.type) }
});

process.once("beforeExit", () => {
  // beforeExit can be emitted more than once; close is idempotent and failures
  // are intentionally contained because there is no protocol-safe stderr body.
  void observability.close().catch(() => undefined);
});
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void host.shutdown().then(() => observability.close()).then(
    () => process.exit(0),
    () => process.exit(1)
  );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
process.stdin.once("end", stop);
process.stdin.once("close", stop);
process.once("exit", () => crashReporter?.close());

/** Parse and validate the on-disk manifest. Only version 1 is supported; each
 * entry names a module, an export, whether that export is a factory, and options. */
function parseManifest(value: unknown): AdapterManifest {
  const record = asRecord(value, "adapter manifest");
  if (record.version !== 1) throw new TypeError("adapter manifest.version must be 1");
  if (!Array.isArray(record.adapters)) throw new TypeError("adapter manifest.adapters must be an array");
  return {
    version: 1,
    adapters: record.adapters.map((item, position) => {
      const entry = asRecord(item, `adapter manifest entry ${position}`);
      const type = optionalString(entry.type);
      return {
        module: requiredString(entry.module, `adapters[${position}].module`),
        exportName: optionalString(entry.export) ?? "default",
        factory: entry.factory === true,
        options: entry.options === undefined ? {} : asRecord(entry.options, `adapters[${position}].options`),
        ...(type ? { type } : {})
      };
    })
  };
}

function callFactory(value: unknown, options: JsonRecord, entry: AdapterManifestEntry): unknown {
  if (typeof value !== "function") {
    throw new TypeError(`${entry.module}#${entry.exportName} is marked as a factory but is not callable`);
  }
  const factory = value as (factoryOptions: JsonRecord) => unknown;
  return factory(options);
}

/** Structural type guard: only `metadata.type`, a string `capabilities` array and
 * an `invoke` method are required, so any conforming object can be a hosted adapter. */
function isHostedAdapter(value: unknown): value is HostedAdapter {
  if (!isRecord(value) || !isRecord(value.metadata)) return false;
  return typeof value.metadata.type === "string" &&
    Array.isArray(value.metadata.agentSources) && value.metadata.agentSources.length > 0 && value.metadata.agentSources.every(source => source === "preset" || source === "provisioned") &&
    Array.isArray(value.metadata.executionFeatures) && value.metadata.executionFeatures.every(feature => typeof feature === "string") &&
    Array.isArray(value.metadata.capabilities) &&
    value.metadata.capabilities.length === 1 && value.metadata.capabilities[0] === "react" &&
    typeof value.invoke === "function";
}

function asRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
