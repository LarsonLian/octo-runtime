#!/usr/bin/env node
// Standalone adapter-host process: load the adapters listed in a JSON manifest,
// register them into an AdapterHost, then serve invocations over NDJSON JSON-RPC
// on stdio (the daemon-to-host transport). Kept separate from the daemon so
// provider processes are isolated behind a process boundary.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveAdapterModuleSpecifier } from "./module-specifier.js";
import { serveAdapterHost, type HostedAdapter } from "./index.js";

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
if (index < 0 || !process.argv[index + 1])
  throw new Error("usage: octo-runtime-adapter-host --manifest <file>");

const manifestPath = resolve(process.argv[index + 1]);
const rawManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
const manifest = parseManifest(rawManifest);
const adapters: HostedAdapter[] = [];

for (const entry of manifest.adapters) {
  const specifier = resolveAdapterModuleSpecifier(entry.module, manifestPath);
  const loaded: unknown = await import(specifier);
  const moduleExports = asRecord(loaded, `adapter module ${entry.module}`);
  const exported = moduleExports[entry.exportName];
  if (exported === undefined) {
    throw new Error(`missing export ${entry.exportName} from ${entry.module}`);
  }

  // The manifest is a dynamic plugin boundary: validate the factory and adapter
  // shape before handing the instance to the host for registration.
  const instance: unknown = entry.factory ? callFactory(exported, entry.options, entry) : exported;
  if (!isHostedAdapter(instance)) {
    throw new TypeError(`${entry.module}#${entry.exportName} is not an Octo Runtime adapter`);
  }
  if (entry.type && instance.metadata.type !== entry.type) {
    throw new Error(`manifest type ${entry.type} does not match adapter ${instance.metadata.type}`);
  }
  adapters.push(instance);
}

// JSON 是 CLI 的装配来源；注册、RPC 和退出清理与 SDK 的代码入口共用。
serveAdapterHost(adapters);

/** Parse and validate the on-disk manifest. Only version 1 is supported; each
 * entry names a module, an export, whether that export is a factory, and options. */
function parseManifest(value: unknown): AdapterManifest {
  const record = asRecord(value, "adapter manifest");
  if (record.version !== 1) throw new TypeError("adapter manifest.version must be 1");
  if (!Array.isArray(record.adapters))
    throw new TypeError("adapter manifest.adapters must be an array");
  return {
    version: 1,
    adapters: record.adapters.map((item, position) => {
      const entry = asRecord(item, `adapter manifest entry ${position}`);
      const type = optionalString(entry.type);
      return {
        module: requiredString(entry.module, `adapters[${position}].module`),
        exportName: optionalString(entry.export) ?? "default",
        factory: entry.factory === true,
        options:
          entry.options === undefined
            ? {}
            : asRecord(entry.options, `adapters[${position}].options`),
        ...(type ? { type } : {})
      };
    })
  };
}

function callFactory(value: unknown, options: JsonRecord, entry: AdapterManifestEntry): unknown {
  if (typeof value !== "function") {
    throw new TypeError(
      `${entry.module}#${entry.exportName} is marked as a factory but is not callable`
    );
  }
  const factory = value as (factoryOptions: JsonRecord) => unknown;
  return factory(options);
}

/** Structural type guard: only `metadata.type`, Agent sources and
 * an `invoke` method are required, so any conforming object can be a hosted adapter. */
function isHostedAdapter(value: unknown): value is HostedAdapter {
  if (!isRecord(value) || !isRecord(value.metadata)) return false;
  return (
    typeof value.metadata.type === "string" &&
    Array.isArray(value.metadata.agentSources) &&
    value.metadata.agentSources.length > 0 &&
    value.metadata.agentSources.every(
      (source) => source === "preset" || source === "provisioned"
    ) &&
    typeof value.invoke === "function"
  );
}

function asRecord(value: unknown, name: string): JsonRecord {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
