#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AdapterHost,
  AdapterHostRpcServer,
  type HostedAdapter
} from "@orbtex-ai/adapter-host";

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
if (index < 0 || !process.argv[index + 1]) throw new Error("usage: orbtex-adapter-host --manifest <file>");

const manifestPath = resolve(process.argv[index + 1]);
const rawManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
const manifest = parseManifest(rawManifest);
const host = new AdapterHost();

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

  // manifest 是动态插件边界：先检查工厂和 adapter 形状，再交给 host 注册。
  const instance: unknown = entry.factory
    ? callFactory(exported, entry.options, entry)
    : exported;
  if (!isHostedAdapter(instance)) {
    throw new TypeError(`${entry.module}#${entry.exportName} is not an Orbtex adapter`);
  }
  if (entry.type && instance.metadata.type !== entry.type) {
    throw new Error(`manifest type ${entry.type} does not match adapter ${instance.metadata.type}`);
  }
  host.register(instance);
}

new AdapterHostRpcServer({ host, output: process.stdout }).listen(process.stdin);

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

function isHostedAdapter(value: unknown): value is HostedAdapter {
  if (!isRecord(value) || !isRecord(value.metadata)) return false;
  return typeof value.metadata.type === "string" &&
    Array.isArray(value.metadata.capabilities) &&
    value.metadata.capabilities.every(capability => typeof capability === "string") &&
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
