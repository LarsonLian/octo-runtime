import { getExtra, setExtra } from "./extras.js";
import { cliVersionInfo, helpText, validateCommand } from "./help.js";
import { formatDaemonResult } from "./daemon-output.js";
import type { ServiceBackend } from "@mininglamp-oss/octo-runtime-cross-service";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import net from "node:net";
import { join, resolve } from "node:path";
import { arch, hostname, platform as osPlatform, release } from "node:os";
import { resolveServiceControl, verifyServiceProgram, type ServiceControlOptions } from "./service-control.js";
import {
  assertHomeConfiguration,
  defaultRuntimeHome,
  ensureMachineIdentity,
  runtimePaths,
  prepareRuntimeDirectories,
  readJsonFile,
  reconcileHomeConfiguration,
  withSetupLock,
  type RuntimeHomeConfiguration,
  type RuntimePaths
} from "./state.js";

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

interface CliRequest {
  method: string;
  params?: Record<string, unknown>;
}

interface CliResponse {
  result?: unknown;
  event?: unknown;
  error?: { message?: string; code?: string };
}

interface CommandResult {
  value?: unknown;
  diagnostic?: string;
  exitCode?: number;
  streamed?: boolean;
}

export interface CliDependencies extends ServiceControlOptions {
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  input?: NodeJS.ReadableStream;
  output?: (value: string) => void;
  errorOutput?: (value: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
  runForegroundDaemon?: (args: string[]) => Promise<number | void>;
}

interface CliContext {
  env: NodeJS.ProcessEnv;
  home: string;
  profile: string;
  paths: RuntimePaths;
  flags: Flags;
  positionals: string[];
  service: ReturnType<typeof resolveServiceControl>;
  fetchImplementation?: typeof fetch;
  input: NodeJS.ReadableStream;
  output: (value: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  runForegroundDaemon: (args: string[]) => Promise<number | void>;
}

const DEFAULT_WAIT_MS = 30_000;
const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "json",
  "noAutostart",
  "tokenStdin",
  "quiet",
  "verbose",
  "waitOnline"
]);

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const normalizedArgs = [...args];
  if (normalizedArgs[0] === "--") normalizedArgs.shift();
  const { positionals, flags } = parseArguments(normalizedArgs);
  const output = dependencies.output ?? (value => process.stdout.write(`${value}\n`));
  const command = validateCommand(positionals, flags);
  if (flags.version === true || (positionals[0] === "version" && flags.help !== true)) {
    output(cliVersionInfo);
    return 0;
  }
  if (command.help) {
    output(helpText(command.path));
    return 0;
  }
  if (positionals[0] === "playboard" && flags.help !== true) {
    if (positionals.length !== 1 || Object.keys(flags).some(key => !["manifest", "home", "profile", "verbose"].includes(key))) {
      throw new Error("playboard accepts only --manifest, --home and --profile; pass the request JSON on stdin");
    }
    const { runPlayboard } = await import("./playboard.js");
    return runPlayboard({
      input: dependencies.input ?? process.stdin,
      output: dependencies.output,
      env: dependencies.env,
      home: optionalString(flags.home) ?? defaultRuntimeHome(dependencies.env, dependencies.platform),
      profile: optionalString(flags.profile) ?? "default",
      manifest: flags.manifest === undefined ? undefined : requiredFlag(flags.manifest, "manifest")
    });
  }
  const profile = optionalString(flags.profile) ?? "default";
  const home = optionalString(flags.home) ?? defaultRuntimeHome(dependencies.env, dependencies.platform);
  const paths = runtimePaths(home, profile);
  const context: CliContext = {
    env: dependencies.env ?? process.env,
    home: paths.home,
    profile,
    paths,
    flags,
    positionals,
    service: resolveServiceControl(dependencies),
    fetchImplementation: dependencies.fetchImplementation,
    input: dependencies.input ?? process.stdin,
    output,
    sleep: dependencies.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
    runForegroundDaemon: dependencies.runForegroundDaemon ?? (async daemonArgs => {
      const originalArgv = process.argv;
      const originalExitCode = process.exitCode;
      process.argv = [process.execPath, originalArgv[1] ?? "octo-runtime", ...daemonArgs];
      process.exitCode = undefined;
      try {
        await import("../../daemon/dist/launcher.js");
        return typeof process.exitCode === "number" ? process.exitCode : 0;
      } finally {
        process.argv = originalArgv;
        process.exitCode = originalExitCode;
      }
    })
  };

  const result = await dispatchCli(context);
  if (result.diagnostic) {
    (dependencies.errorOutput ?? (value => process.stderr.write(`${value}\n`)))(result.diagnostic);
  }
  if (!result.streamed && result.value !== undefined) {
    output(positionals[0] === "daemon" && flags.json !== true && typeof result.value !== "string"
      ? formatDaemonResult(result.value)
      : typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
  }
  return result.exitCode ?? 0;
}

async function dispatchCli(context: CliContext): Promise<CommandResult> {
  const [group, action, id] = context.positionals;
  if (group === "extraset") {
    return { value: await setExtra(context.paths, required(action, "extra-name"), context.input) };
  }
  if (group === "extraget") return {
    value: await getExtra(context.paths, required(action, "extra-name")),
    diagnostic: `Config file: ${join(context.home, "extras", action, "config.json")}`
  };
  if (group === "status") return { value: await readRuntimeStatus(context.paths.socket) };
  if (group === "daemon") return runDaemonCommand(context, action);
  if (group === "doctor") return runDoctor(context);
  const request = daemonRequest(group, action, id);
  if (group === "adapter") request.params = { ...request.params, profile: context.profile };
  return { value: await callDaemon(context.paths.socket, request) };
}

async function runDaemonCommand(context: CliContext, action: string | undefined): Promise<CommandResult> {
  if (!action) return { value: helpText(["daemon"]) };
  const selected = action;
  if (selected === "run") {
    await withSetupLock(context.paths, () => ensureLocalRuntime(context));
    const exitCode = await context.runForegroundDaemon([
      "--home", context.home,
      ...loggingArguments(context),
      ...(context.flags.quiet === true ? [] : ["--console"]),
      ...(context.flags.verbose === true ? ["--verbose"] : [])
    ]);
    return { streamed: true, exitCode: exitCode ?? 0 };
  }
  if (selected === "install") return installDaemonService(context);
  if (selected === "uninstall") return uninstallDaemonService(context);
  const spec = await daemonServiceSpec(context);
  if (selected === "status") {
    const service = await context.service.backend.inspect(spec);
    const application = await readRuntimeStatus(context.paths.socket).catch(() => undefined);
    return { value: { service, application: application ?? { ready: false } } };
  }
  if (!["start", "stop", "restart"].includes(selected)) {
    throw new Error("daemon action must be install, uninstall, run, start, stop, restart, or status");
  }
  if (selected === "stop") {
    daemonProgress(context, "Stopping background service...");
    await context.service.backend.stop(spec);
    daemonProgress(context, "Waiting for backend to stop...");
    await waitForDaemonStopped(context, 15_000);
    return { value: { ok: true, action: "stop", service: await context.service.backend.inspect(spec) } };
  }
  if (context.flags.waitOnline) throw new Error("Worker cloud connections are no longer built in");
  if (selected === "start") {
    daemonProgress(context, "Checking background service...");
    await installDaemonService(context, true);
  }
  await verifyServiceProgram(spec);
  if (selected === "restart") {
    daemonProgress(context, "Restarting background service...");
    await context.service.backend.restart(spec);
  } else {
    daemonProgress(context, "Starting backend in the background...");
    await context.service.backend.start(spec);
  }
  daemonProgress(context, "Waiting for local backend readiness...");
  const readiness = await waitForDaemonReady(context, DEFAULT_WAIT_MS);
  return {
    value: {
      ok: true,
      action: selected,
      service: await context.service.backend.inspect(spec),
      readiness
    }
  };
}

async function installDaemonService(context: CliContext, onlyIfMissing = false): Promise<CommandResult> {
  return withSetupLock(context.paths, async () => {
    if (onlyIfMissing) {
      const spec = await daemonServiceSpec(context);
      const service = await context.service.backend.inspect(spec);
      if (service.state !== "not_installed") {
        daemonProgress(context, "Background service is already installed.");
        return {};
      }
    }
    await ensureLocalRuntime(context);
    const autostart = onlyIfMissing || context.flags.noAutostart !== true;
    const spec = context.service.spec(context.paths, autostart, loggingArguments(context));
    await verifyServiceProgram(spec);
    const probe = await context.service.backend.probe();
    if (!probe.supported) {
      throw new Error(`${probe.manager} is unavailable: ${probe.detail ?? "unsupported user session"}`);
    }
    daemonProgress(context, `Installing background service (${probe.manager})...`);
    await context.service.backend.install(spec);
    daemonProgress(context, autostart ? "Enabling start at login..." : "Disabling start at login...");
    if (autostart) await context.service.backend.enable(spec);
    else await context.service.backend.disable(spec);
    return {
      value: {
        ok: true,
        action: "install",
        service: await context.service.backend.inspect(spec)
      }
    };
  });
}

async function uninstallDaemonService(context: CliContext): Promise<CommandResult> {
  return withSetupLock(context.paths, async () => {
    const spec = await daemonServiceSpec(context);
    const before = await context.service.backend.inspect(spec);
    const application = await tryDaemonStatus(context.paths.socket);
    const managedProcessActive = ["running", "starting", "stopping"].includes(before.state);
    daemonProgress(context, "Stopping and removing background service...");
    await context.service.backend.uninstall(spec);
    if (application && managedProcessActive) {
      await waitForDaemonStopped(context, 15_000);
    }
    return {
      value: {
        ok: true,
        action: "uninstall",
        service: await context.service.backend.inspect(spec),
        data_preserved: true
      }
    };
  });
}

function daemonProgress(context: CliContext, message: string): void {
  if (context.flags.json !== true) context.output(message);
}

async function readRuntimeStatus(socketPath: string): Promise<Record<string, unknown>> {
  const application = await callDaemon<Record<string, unknown>>(socketPath, { method: "status" });
  const extras = application.extras;
  if (!extras || typeof extras !== "object" || Array.isArray(extras)) return application;
  const entries = await Promise.all(Object.entries(extras).map(async ([name, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [name, value] as const;
    const lifecycle = value as Record<string, unknown>;
    if (lifecycle.phase !== "loaded") return [name, lifecycle] as const;
    try {
      const status = await callDaemon(socketPath, { method: "extra.status", params: { name } });
      return [name, { ...lifecycle, status }] as const;
    } catch {
      return [name, { ...lifecycle, status_error: "EXTRA_STATUS_FAILED" }] as const;
    }
  }));
  return { ...application, extras: Object.fromEntries(entries) };
}

// Call under the Home setup lock; existing configuration and identity stay intact.
async function ensureLocalRuntime(context: CliContext): Promise<void> {
  const homeConfiguration = await readJsonFile<RuntimeHomeConfiguration>(context.paths.rootConfig);
  assertHomeConfiguration(homeConfiguration);
  await ensureMachineIdentity(context.paths);
  await prepareRuntimeDirectories(context.paths);
  if (homeConfiguration === undefined) {
    await reconcileHomeConfiguration(context.paths, context.profile, "stable");
  }
}

async function runDoctor(context: CliContext): Promise<CommandResult> {
  const checks: Array<Record<string, unknown>> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(check("node.version", nodeMajor >= 24, `Node.js ${process.versions.node}`, "Install Node.js 24 or newer"));
  const homeConfig = await inspectJson<RuntimeHomeConfiguration>(context.paths.rootConfig);
  checks.push(check("home.config", homeConfig.ok, homeConfig.detail, "Run octo-runtime daemon install or daemon run"));
  const spec = await daemonServiceSpec(context);
  const program = await pathCheck(spec.command, spec.args?.[0]);
  checks.push(check("service.program", program.ok, program.detail, "Rerun the installer to repair absolute program paths"));
  const probe = await context.service.backend.probe();
  checks.push(check("service.manager", probe.supported, probe.detail ?? probe.manager, "Use a supported current-user service session"));
  if (probe.supported) {
    const service = await context.service.backend.inspect(spec);
    checks.push(check(
      "service.definition",
      service.state !== "not_installed" && service.drift.length === 0,
      `${service.state}; drift=${service.drift.join(",") || "none"}`,
      "Run octo-runtime daemon install to reconcile the service definition"
    ));
  }
  const application = await tryDaemonStatus(context.paths.socket);
  checks.push(check("daemon.ipc", Boolean(application), application ? "ready" : "not reachable", "Run octo-runtime daemon start"));
  const ok = checks.every(item => item.ok === true);
  return { value: { ok, profile: context.profile, home: context.home, checks }, exitCode: ok ? 0 : 1 };
}

function daemonRequest(group: string, action: string | undefined, id: string | undefined): CliRequest {
  if (group === "status") return { method: "status" };
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") {
    return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  }
  throw new Error("unknown command; run octo-runtime help");
}

export async function callDaemon<T = unknown>(socketPath: string, request: CliRequest): Promise<T> {
  const socket = await connectDaemon(socketPath);
  socket.write(`${JSON.stringify({ id: randomUUID(), ...request })}\n`);
  const response = await new Promise<CliResponse>((resolveResponse, reject) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffered += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      socket.removeAllListeners("data");
      try {
        resolveResponse(JSON.parse(buffered.slice(0, newline)) as CliResponse);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid daemon response", { cause: error }));
      }
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (!buffered.includes("\n")) reject(new Error("daemon closed before returning a response"));
    });
  });
  socket.destroy();
  if (response.error) throw new Error(response.error.message ?? "daemon request failed");
  return response.result as T;
}

async function waitForDaemonReady(context: CliContext, timeoutMs: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const status = await callDaemon<Record<string, unknown>>(context.paths.socket, { method: "status" });
      if (status.ready === true) return status;
    } catch (error) {
      lastError = error;
    }
    await context.sleep(100);
  }
  throw new Error(`daemon did not become ready within ${timeoutMs}ms`, { cause: lastError });
}

async function waitForDaemonStopped(context: CliContext, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await tryDaemonStatus(context.paths.socket)) return;
    await context.sleep(100);
  }
  throw new Error(`daemon IPC remained reachable after ${timeoutMs}ms`);
}

async function tryDaemonStatus(socketPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await callDaemon<Record<string, unknown>>(socketPath, { method: "status" });
  } catch {
    return undefined;
  }
}

async function connectDaemon(socketPath: string): Promise<net.Socket> {
  const socket = net.createConnection(socketPath);
  try {
    await new Promise<void>((resolveConnection, reject) => {
      socket.once("connect", resolveConnection);
      socket.once("error", reject);
    });
  } catch (error) {
    socket.destroy();
    const code = (error as NodeJS.ErrnoException).code;
    if (code && ["ENOENT", "ECONNREFUSED", "EINVAL"].includes(code)) {
      throw new Error(`cannot connect to Octo Runtime daemon at ${socketPath}; start it with: octo-runtime daemon start`, {
        cause: error
      });
    }
    throw error;
  }
  return socket;
}

async function inspectJson<T>(path: string): Promise<{ ok: boolean; detail: string; value?: T }> {
  try {
    const value = await readJsonFile<T>(path);
    return value ? { ok: true, detail: path, value } : { ok: false, detail: `missing: ${path}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function pathCheck(...paths: Array<string | undefined>): Promise<{ ok: boolean; detail: string }> {
  try {
    const selected = paths.filter((value): value is string => Boolean(value));
    await Promise.all(selected.map(path => access(path)));
    return { ok: true, detail: selected.join(", ") };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function check(id: string, ok: boolean, detail: string, remediation: string): Record<string, unknown> {
  return { id, ok, detail, ...(ok ? {} : { remediation }) };
}

function parseArguments(args: string[]): { flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index] === "-h" ? "--help" : args[index] === "-v" ? "--version" : args[index];
    if (argument.startsWith("-") && !argument.startsWith("--")) throw new Error(`unknown option ${argument}`);
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const rawKey = argument.slice(2, separator < 0 ? undefined : separator);
    const normalizedKey = rawKey.replace(/[-_]([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const key = normalizedKey === "agentIdentit" ? "agentIdentity" : normalizedKey;
    if (!["home", "profile", "manifest", ...BOOLEAN_FLAGS].includes(key)) throw new Error(`unknown option --${rawKey}`);
    if (["force", "timeoutMs", "waitDrained"].includes(key)) throw new Error(`unknown option --${rawKey}`);
    if ((key === "agentIdentity" || key === "agentName") && Object.hasOwn(flags, key)) throw new Error(`duplicate --${rawKey}`);
    if (BOOLEAN_FLAGS.has(key)) {
      if (separator >= 0) throw new Error(`--${rawKey} does not accept a value`);
      flags[key] = true;
      continue;
    }
    const next = args[index + 1];
    flags[key] = separator >= 0 ? argument.slice(separator + 1) : next && !next.startsWith("-") ? args[++index] : true;
    if (typeof flags[key] !== "string" || !flags[key]) throw new Error(`--${rawKey} requires a nonempty value`);
    if ((key === "agentIdentity" || key === "agentName") && (typeof flags[key] !== "string" || !flags[key])) throw new Error(`--${rawKey} requires a nonempty value`);
  }
  return { flags, positionals };
}

function required(value: FlagValue | string | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing --${name}`);
  return value;
}

function requiredFlag(value: FlagValue | undefined, name: string): string {
  return required(value, name);
}

function optionalString(value: FlagValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function daemonServiceSpec(context: CliContext, enabled = true) {
  const configuration = await readJsonFile<RuntimeHomeConfiguration>(context.paths.rootConfig);
  assertHomeConfiguration(configuration);
  return context.service.spec(
    context.paths,
    enabled,
    loggingArguments(context)
  );
}

function loggingArguments(context: CliContext): string[] {
  return context.flags.logsDir === undefined ? [] : ["--logs-dir", resolve(requiredFlag(context.flags.logsDir, "logs-dir"))];
}


export function runtimeFingerprint(): string {
  return createHash("sha256")
    .update([hostname(), osPlatform(), release(), arch()].join("\0"))
    .digest("hex");
}

export type { ServiceBackend };
