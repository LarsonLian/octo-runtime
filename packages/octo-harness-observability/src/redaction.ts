import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { ProviderCarrier } from "./types.js";

interface YamlModule {
  JSON_SCHEMA: unknown;
  load(value: string, options: { schema: unknown }): unknown;
  dump(value: unknown, options: { schema: unknown; noRefs: boolean; sortKeys: boolean }): string;
}

interface ParsedInlineConfiguration {
  format: "json" | "yaml" | "toml";
  value: unknown;
}

const yaml = createRequire(import.meta.url)("js-yaml") as YamlModule;

const CREDENTIAL_EXACT = new Set(["authorization", "proxyauthorization", "cookie", "setcookie"]);
const CREDENTIAL_SUFFIXES = [
  "token",
  "password",
  "passwd",
  "secret",
  "apikey",
  "privatekey",
  "accesskey",
  "credential"
];
const OMIT = Symbol("omit-sensitive-value");
const PRIVATE_BODY_KEYS = new Set(["text", "delta", "content", "body", "reasoning", "output"]);
const MAX_INLINE_CONFIGURATION_BYTES = 1024 * 1024;

interface RedactionState {
  complete: boolean;
  excluded: Set<string>;
  seen: WeakSet<object>;
}

export interface RedactionResult<T = unknown> {
  value: T;
  /** False only when a credential-shaped carrier could not be parsed safely. */
  complete: boolean;
  /** Normalized JSON paths identify intentionally excluded credential carriers. */
  excludedCredentialPaths: string[];
}

export interface CarrierProjection extends Record<string, unknown> {
  sha256: string;
  byte_length: number;
  complete: boolean;
  excluded_credential_paths: string[];
}

/** Preserve the legacy projection-only API while applying the fail-safe policy. */
export function redactCredentials(value: unknown): unknown {
  return redactCredentialsWithMetadata(value).value;
}

/**
 * Remove known credential carriers before serialization and report every removal.
 * Unparseable URL-shaped fields are omitted wholesale because retaining an
 * ambiguous carrier is less safe than losing non-essential diagnostic metadata.
 */
export function redactCredentialsWithMetadata<T = unknown>(value: T): RedactionResult<T> {
  const state: RedactionState = { complete: true, excluded: new Set(), seen: new WeakSet() };
  const redacted = redactValue(value, state, "$", undefined);
  return {
    value: (redacted === OMIT ? undefined : redacted) as T,
    complete: state.complete,
    excludedCredentialPaths: [...state.excluded].sort()
  };
}

function redactValue(
  value: unknown,
  state: RedactionState,
  path: string,
  parentKey: string | undefined
): unknown {
  if (typeof value === "string") {
    if (/^data:image\//i.test(value)) return "[image content omitted]";
    if (parentKey && inlineConfigurationKey(parentKey)) return redactInlineConfiguration(value, path, state);
    if (parentKey && urlKey(parentKey)) return redactUrl(value, path, state);
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array) {
    return { storage_encoding: "base64", content_b64: Buffer.from(value).toString("base64") };
  }
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value);
  if (Array.isArray(value)) {
    return parentKey && argvKey(parentKey)
      ? redactArgv(value, path, state)
      : value.map((item, index) => {
          const nested = redactValue(item, state, `${path}[${index}]`, parentKey);
          return nested === OMIT ? "[omitted]" : nested;
        });
  }
  const output: Record<string, unknown> = {};
  const envContext = (value as Record<string, unknown>).namespace === "octo.execution" && (value as Record<string, unknown>).name === "envs";
  const image = (value as Record<string, unknown>).type === "image" || typeof (value as Record<string, unknown>).mimeType === "string" && String((value as Record<string, unknown>).mimeType).startsWith("image/");
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (image && ["data", "data_base64", "content_b64"].includes(key)) {
      output[key] = "[image content omitted]";
      continue;
    }
    const nestedPath = `${path}.${normalizedKey(key) || "field"}`;
    if (credentialKey(key) || key === "envs" || key === "shell_environment_policy.set" || (parentKey === "shell_environment_policy" && key === "set") || (envContext && key === "payload")) {
      state.excluded.add(nestedPath);
      continue;
    }
    const redacted = redactValue(nested, state, nestedPath, key);
    if (redacted !== OMIT) output[key] = redacted;
  }
  return output;
}

function credentialKey(key: string): boolean {
  const normalized = normalizedKey(key.replace(/^-+/, ""));
  return CREDENTIAL_EXACT.has(normalized)
    || CREDENTIAL_SUFFIXES.some(suffix => normalized.endsWith(suffix));
}

function normalizedKey(key: string): string {
  return key.normalize("NFKC").toLowerCase().replace(/[-_.]/g, "");
}

function argvKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized === "args" || normalized === "argv" || normalized.endsWith("arguments");
}

function urlKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return normalized.endsWith("url") || normalized.endsWith("uri") || normalized.endsWith("endpoint");
}

function inlineConfigurationKey(key: string): boolean {
  const normalized = normalizedKey(key.replace(/^-+/, ""));
  return normalized.endsWith("config")
    || normalized.endsWith("configuration")
    || normalized.endsWith("configcontent");
}

/** Parse both `--secret=value` and `--secret value` without retaining values. */
function redactArgv(values: unknown[], path: string, state: RedactionState): unknown[] {
  const output: unknown[] = [];
  let pendingKey: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (pendingKey && credentialKey(pendingKey)) {
      output.push("[redacted]");
      state.excluded.add(`${path}[${index}]`);
      pendingKey = undefined;
      continue;
    }
    if (pendingKey && !(typeof value === "string" && /^--?/.test(value))) {
      const nested = redactArgumentValue(value, pendingKey, `${path}[${index}]`, state);
      output.push(nested === OMIT ? "[omitted]" : nested);
      pendingKey = undefined;
      continue;
    }
    pendingKey = undefined;
    if (typeof value !== "string") {
      const nested = redactValue(value, state, `${path}[${index}]`, undefined);
      output.push(nested === OMIT ? "[omitted]" : nested);
      continue;
    }
    const equals = /^(--?[^=]+)=(.*)$/s.exec(value);
    if (equals && credentialKey(equals[1])) {
      output.push(`${equals[1]}=[redacted]`);
      state.excluded.add(`${path}[${index}]`);
      continue;
    }
    if (equals) {
      const nested = redactArgumentValue(equals[2], equals[1], `${path}[${index}]`, state);
      output.push(nested === OMIT ? `${equals[1]}=[omitted]` : `${equals[1]}=${String(nested)}`);
      continue;
    }
    if (/^--?/.test(value)) {
      output.push(value);
      pendingKey = value;
      continue;
    }
    const nested = redactArgumentValue(value, "", `${path}[${index}]`, state);
    output.push(nested === OMIT ? "[omitted]" : nested);
  }
  return output;
}

function redactArgumentValue(
  value: unknown,
  key: string,
  path: string,
  state: RedactionState
): unknown {
  if (typeof value !== "string") return redactValue(value, state, path, key || undefined);
  if (inlineConfigurationKey(key)) return redactInlineConfiguration(value, path, state);
  if (urlKey(key) || looksLikeAbsoluteUrl(value)) return redactUrl(value, path, state);
  return value;
}

function looksLikeAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(value);
}

/** Parse string configuration before recursively applying the shared key policy. */
function redactInlineConfiguration(value: string, path: string, state: RedactionState): string | typeof OMIT {
  if (Buffer.byteLength(value) > MAX_INLINE_CONFIGURATION_BYTES) {
    state.complete = false;
    state.excluded.add(path);
    return OMIT;
  }
  const parsed = parseInlineConfiguration(value);
  if (!parsed) {
    state.complete = false;
    state.excluded.add(path);
    return OMIT;
  }
  const redacted = redactValue(parsed.value, state, `${path}.${parsed.format}`, undefined);
  try {
    if (parsed.format === "json") return JSON.stringify(redacted);
    if (parsed.format === "toml") return stringifyToml(redacted);
    return yaml.dump(redacted, { schema: yaml.JSON_SCHEMA, noRefs: true, sortKeys: true });
  } catch {
    state.complete = false;
    state.excluded.add(path);
    return OMIT;
  }
}

function parseInlineConfiguration(value: string): ParsedInlineConfiguration | undefined {
  const parsers: Array<ParsedInlineConfiguration["format"]> = ["json", "yaml", "toml"];
  for (const format of parsers) {
    try {
      const parsed: unknown = format === "json"
        ? JSON.parse(value) as unknown
        : format === "yaml"
          ? yaml.load(value, { schema: yaml.JSON_SCHEMA })
          : parseToml(value);
      if (parsed !== null && typeof parsed === "object") return { format, value: parsed };
    } catch {
      // Try the next declared inline configuration syntax before failing closed.
    }
  }
  return undefined;
}

function redactUrl(value: string, path: string, state: RedactionState): string | typeof OMIT {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = "";
      url.password = "";
      state.excluded.add(`${path}.userinfo`);
    }
    for (const key of [...url.searchParams.keys()]) {
      if (!credentialKey(key)) continue;
      url.searchParams.delete(key);
      state.excluded.add(`${path}.query.${normalizedKey(key)}`);
    }
    return url.toString();
  } catch {
    state.complete = false;
    state.excluded.add(path);
    return OMIT;
  }
}

/**
 * Strip private reasoning bodies from arbitrary RPC/provider-output shapes.
 * A digest and byte count preserve diagnostics without persisting the body.
 */
export function redactPrivateReasoning(value: unknown): unknown {
  return redactPrivateValue(value);
}

function redactPrivateValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPrivateValue);
  if (!isObjectRecord(value)) return value;

  const output = { ...value };
  if (containsPrivateReasoning(output.canonical) && "native" in output) {
    output.native = bodyReceipt(output.native);
  }
  if (output.exposure === "private_reasoning") return redactPrivateObject(output);
  if (isObjectRecord(output.payload) && output.payload.exposure === "private_reasoning") {
    output.payload = redactPrivateObject(output.payload);
    return output;
  }
  for (const [key, nested] of Object.entries(output)) output[key] = redactPrivateValue(nested);
  return output;
}

function redactPrivateObject(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  const body: Record<string, unknown> = {};
  for (const key of PRIVATE_BODY_KEYS) {
    if (!(key in output)) continue;
    body[key] = output[key];
    delete output[key];
  }
  if (isObjectRecord(output.payload) && output.payload.exposure === "private_reasoning") {
    output.payload = redactPrivateObject(output.payload);
  }
  const receipt = bodyReceipt(body);
  output.body_omitted = true;
  if (receipt.body_sha256) output.body_sha256 = receipt.body_sha256;
  if (receipt.body_byte_length) output.body_byte_length = receipt.body_byte_length;
  return output;
}

function bodyReceipt(value: unknown): Record<string, unknown> {
  const bytes = Buffer.from(canonicalJson(value));
  const metadata = isObjectRecord(value)
    ? Object.fromEntries(
        ["type", "method", "event", "id", "exposure", "channel"]
          .filter(key => typeof value[key] === "string")
          .map(key => [key, value[key]])
      )
    : {};
  return {
    ...metadata,
    body_omitted: true,
    body_sha256: sha256(bytes),
    body_byte_length: bytes.byteLength
  };
}

function containsPrivateReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateReasoning);
  if (!isObjectRecord(value)) return false;
  if (value.exposure === "private_reasoning") return true;
  return Object.values(value).some(containsPrivateReasoning);
}

export function projectCarrier(carrier: ProviderCarrier): CarrierProjection {
  if (carrier.kind === "bytes") {
    const bytes = Buffer.from(carrier.content);
    return {
      kind: "bytes",
      storage_encoding: "base64",
      content_b64: bytes.toString("base64"),
      sha256: sha256(bytes),
      byte_length: bytes.byteLength,
      complete: true,
      excluded_credential_paths: []
    };
  }
  const redaction = redactCredentialsWithMetadata(carrier.content);
  const content = redactPrivateReasoning(redaction.value);
  const bytes = Buffer.from(canonicalJson(content));
  return {
    kind: "json_params",
    encoding: "rfc8785-json",
    content,
    sha256: sha256(bytes),
    byte_length: bytes.byteLength,
    complete: redaction.complete,
    excluded_credential_paths: redaction.excludedCredentialPaths
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? "null";
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, canonicalValue(nested)])
    );
  }
  return value;
}

export function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
