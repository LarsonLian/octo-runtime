import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertExtraName,
  type ExtraRegistration,
  type JsonObject,
  type ExtraPluginModule
} from "./extras.js";

/** Host-owned, serializable declaration; config remains plugin-specific JSON. */
export interface ExtraDescriptor {
  name: string;
  module: string;
  enabled?: boolean;
  config: JsonObject;
}
export type StoredExtra = Omit<ExtraDescriptor, "name">;

export function assertStoredExtra(value: unknown): asserts value is StoredExtra {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("EXTRA_CONFIG_OBJECT_REQUIRED");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["module", "enabled", "config"].includes(key)))
    throw new Error("EXTRA_CONFIG_FIELD_INVALID");
  if (typeof item.module !== "string" || !validModule(item.module))
    throw new Error("EXTRA_MODULE_INVALID");
  if (item.enabled !== undefined && typeof item.enabled !== "boolean")
    throw new Error("EXTRA_ENABLED_INVALID");
  if (!item.config || typeof item.config !== "object" || Array.isArray(item.config))
    throw new Error("EXTRA_CONFIG_OBJECT_REQUIRED");
  // Reject non-JSON SDK values instead of silently losing them during IPC serialization.
  const visit = (value: unknown, seen: Set<object>): void => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value !== "object" || !value || seen.has(value))
      throw new Error("EXTRA_CONFIG_JSON_REQUIRED");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error("EXTRA_CONFIG_JSON_REQUIRED");
    seen.add(value);
    for (const child of Object.values(value)) visit(child, seen);
    seen.delete(value);
  };
  visit(item.config, new Set());
}

export function extraRegistration(descriptor: ExtraDescriptor): ExtraRegistration {
  assertExtraName(descriptor.name);
  const { name, ...stored } = descriptor;
  assertStoredExtra(stored);
  return {
    name,
    module: stored.module,
    config: stored.config,
    enabled: stored.enabled,
    load: () =>
      import(
        isAbsolute(stored.module) ? pathToFileURL(stored.module).href : stored.module
      ) as Promise<ExtraPluginModule>
  };
}

/** Called only by a host that explicitly selects this directory as its source. */
export async function readExtraDirectory(directory: string): Promise<ExtraRegistration[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const registrations: ExtraRegistration[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    assertExtraName(entry.name);
    try {
      const file = join(directory, entry.name, "config.json");
      const info = await lstat(file);
      if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
        throw new Error("EXTRA_CONFIG_PERMISSIONS_INVALID");
      if (info.size > 1024 * 1024) throw new Error("EXTRA_CONFIG_TOO_LARGE");
      const stored: unknown = JSON.parse(await readFile(file, "utf8"));
      assertStoredExtra(stored);
      registrations.push(extraRegistration({ name: entry.name, ...stored }));
    } catch (error) {
      const code =
        error instanceof Error && /^EXTRA_[A-Z_]+$/.test(error.message)
          ? error.message
          : "EXTRA_CONFIG_READ_FAILED";
      registrations.push({
        name: entry.name,
        config: {},
        load: () => Promise.reject(new Error(code))
      });
    }
  }
  return registrations;
}

function validModule(module: string): boolean {
  if (isAbsolute(module)) return true;
  if (module.startsWith("file:")) {
    try {
      const url = new URL(module);
      return url.protocol === "file:" && !url.search && !url.hash;
    } catch {
      return false;
    }
  }
  return /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-zA-Z0-9._-]+)*$/.test(module);
}
