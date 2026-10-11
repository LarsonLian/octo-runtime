import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export interface PreparedCliBinding { name: string; path: string }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const envName = (s: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(s) && !["PATH", "HOME", "CODEX_HOME", "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"].includes(s);
const quote = (s: string): string => "'" + s.replaceAll("'", "'\\''") + "'";

/** Local command bindings consume only credentials already prepared for the selected MCP target. */
export async function prepareCliBindings(raw: string, options: {
  stateRoot: string; credentials: Record<string, Record<string, string>>;
  selectedServers: Set<string>; registerCleanup: (path: string) => void;
  searchPath?: string; signal?: AbortSignal;
}): Promise<PreparedCliBinding[]> {
  options.signal?.throwIfAborted();
  const document: unknown = JSON.parse(raw);
  if (!object(document) || document.schema !== "octo.cli-bindings/v1" || !Array.isArray(document.bindings) || document.bindings.length > 8) throw new TypeError("CLI_BINDINGS_INVALID");
  if (process.platform === "win32") throw new TypeError("CLI_BINDINGS_PLATFORM_UNSUPPORTED");
  const result: PreparedCliBinding[] = [];
  for (const binding of document.bindings) {
    if (!object(binding) || typeof binding.command !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(binding.command)
      || typeof binding.server !== "string" || !options.selectedServers.has(binding.server)
      || typeof binding.credential_file_env !== "string" || !envName(binding.credential_file_env)
      || !object(binding.env) || Object.keys(binding.env).length > 16
      || !Array.isArray(binding.unset_env) || binding.unset_env.length > 16
      || binding.unset_env.some((name: unknown) => typeof name !== "string" || !envName(name))
      || Object.entries(binding.env).some(([key, value]) => !envName(key) || typeof value !== "string" || value.length > 2048 || (value.includes("\0") || /[\r\n]/.test(value)))
      || Object.hasOwn(binding.env, binding.credential_file_env)) throw new TypeError("CLI_BINDINGS_INVALID");
    const credentials = options.credentials[binding.server];
    if (!credentials?.Authorization?.startsWith("Bearer octo_run_") || !credentials["X-Space-ID"] || !credentials["X-Namespace"]) throw new TypeError("CLI_BINDING_CREDENTIALS_REQUIRED");
    let executable: string | undefined;
    for (const dir of (options.searchPath ?? process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = resolve(dir, binding.command);
      try { await access(candidate, constants.X_OK); executable = candidate; break; } catch { /* Try the next installed command. */ }
    }
    if (!executable) throw new TypeError("CLI_COMMAND_UNAVAILABLE: " + binding.command);
    const parent = join(options.stateRoot, "run-cli");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const root = await mkdtemp(join(parent, "binding-"));
    try {
      options.signal?.throwIfAborted();
      options.registerCleanup(root);
      const file = join(root, "credentials.json");
      await writeFile(file, JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
      const path = join(root, binding.command);
      const args = [...binding.unset_env.flatMap((name: string) => ["-u", name]),
        ...Object.entries(binding.env).map(([name, value]) => name + "=" + String(value)), binding.credential_file_env + "=" + file, executable];
      await writeFile(path, "#!/bin/sh\nexec /usr/bin/env " + args.map(quote).join(" ") + ' "$@"\n', { mode: 0o700, flag: "wx" });
      options.signal?.throwIfAborted();
      result.push({ name: binding.command, path });
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
  return result;
}
