import { configureChannel } from "./channel.js";
import { setExtra } from "./extras.js";
import {
  configureOpenClawConnection,
  createOpenClawAdapter,
  OPENCLAW_RUNTIME_ROOT,
  type OpenClawConnectionInput
} from "@mininglamp-oss/octo-runtime-adapter-openclaw";
import type { ServiceBackend } from "@mininglamp-oss/octo-runtime-cross-service";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import net from "node:net";
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
  writeJsonAtomic,
  type RuntimeHomeConfiguration,
  type RuntimePaths,
  type UpdateJournal
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
  exitCode?: number;
  streamed?: boolean;
}

export interface CliDependencies extends ServiceControlOptions {
  env?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  input?: NodeJS.ReadableStream;
  output?: (value: string) => void;
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
  "enrollTokenStdin",
  "help",
  "json",
  "noAutostart",
  "tokenStdin",
  "prepareUpdate",
  "quiet",
  "recoverUpdate",
  "start",
  "verbose",
  "waitOnline"
]);

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const normalizedArgs = [...args];
  if (normalizedArgs[0] === "--") normalizedArgs.shift();
  const { positionals, flags } = parseArguments(normalizedArgs);
  if (positionals[0] === "playboard" && flags.help !== true) {
    if (positionals.length !== 1 || Object.keys(flags).some(key => !["manifest", "home", "profile"].includes(key))) {
      throw new Error("playboard accepts only --manifest, --home and --profile; pass the request JSON on stdin");
    }
    const { runPlayboard } = await import("./playboard.js");
    return runPlayboard({
      input: dependencies.input ?? process.stdin,
      output: dependencies.output,
      env: dependencies.env,
      runtimeRoot: runtimePaths(optionalString(flags.home) ?? defaultRuntimeHome(dependencies.env, dependencies.platform), optionalString(flags.profile) ?? "default").profileRoot,
      manifest: flags.manifest === undefined ? undefined : requiredFlag(flags.manifest, "manifest")
    });
  }
  const profile = optionalString(flags.profile) ?? "default";
  const home = optionalString(flags.home) ?? defaultRuntimeHome(dependencies.env, dependencies.platform);
  const paths = runtimePaths(home, profile);
  const output = dependencies.output ?? (value => process.stdout.write(`${value}\n`));
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
  if (!result.streamed && result.value !== undefined) {
    output(typeof result.value === "string" ? result.value : JSON.stringify(result.value, null, 2));
  }
  return result.exitCode ?? 0;
}

async function dispatchCli(context: CliContext): Promise<CommandResult> {
  const [group, action, id] = context.positionals;
  if (!group || group === "help" || context.flags.help === true) {
    return { value: helpText(group === "help" ? action : group) };
  }
  if (group === "extraset") {
    if (context.positionals.length !== 2 || Object.keys(context.flags).some(key => key !== "home"))
      throw new Error("extraset accepts a name and --home; pass the complete JSON object on stdin");
    return { value: await setExtra(context.paths, required(action, "extra-name"), context.input) };
  }
  if (group === "channel" && action === "configure") {
    if (context.positionals.length !== 2 || Object.keys(context.flags).some(key => key !== "home"))
      throw new Error("channel configure accepts only --home; pass one Bot JSON object on stdin");
    return { value: await configureChannel(context.paths, context.input) };
  }
  if (group === "login") return runLogin(context);
  if (group === "adapter" && action === "connect") return runAdapterConnectCommand(context, id);
  if (group === "daemon") return runDaemonCommand(context, action);
  if (group === "doctor") return runDoctor(context);
  const request = daemonRequest(group, action, id, context.flags);
  if (group === "adapter") request.params = { ...request.params, profile: context.profile };
  return { value: await callDaemon(context.paths.socket, request) };
}

async function runLogin(context: CliContext): Promise<CommandResult> {
  return withSetupLock(context.paths, async () => {
    await prepareRuntimeDirectories(context.paths);
    if (context.flags.prepareUpdate === true && context.flags.recoverUpdate === true)
      throw new Error("--prepare-update and --recover-update are mutually exclusive update modes");
    if (context.flags.prepareUpdate === true) return prepareUpdate(context);
    if (context.flags.recoverUpdate === true) return recoverUpdate(context);
    if (context.flags.enrollTokenStdin || context.flags.serverUrl || context.flags.agentWorkUrl || context.flags.waitOnline)
      throw new Error("Worker enrollment has moved to the standalone worker-access archive");
    await ensureMachineIdentity(context.paths);
    await reconcileHomeConfiguration(context.paths, context.profile, enumFlag(context.flags.channel, ["stable", "beta"] as const, "stable"));
    return { value: { ok: true, home: context.home, profile: context.profile, local: true } };
  });
}

async function prepareUpdate(context: CliContext): Promise<CommandResult> {
  const spec = await daemonServiceSpec(context);
  const current = await context.service.backend.inspect(spec);
  const wasRunning = ["running", "starting"].includes(current.state);
  if (wasRunning) await context.service.backend.stop(spec);
  const journal: UpdateJournal = {
    schema_version: 1,
    phase: "prepared",
    profile: context.profile,
    service_was_running: wasRunning,
    prepared_at: new Date().toISOString()
  };
  await writeJsonAtomic(context.paths.updateJournal, journal);
  return { value: { ok: true, prepared: true, service_was_running: wasRunning } };
}

async function recoverUpdate(context: CliContext): Promise<CommandResult> {
  const journal = await readJsonFile<UpdateJournal>(context.paths.updateJournal);
  const spec = await daemonServiceSpec(context);
  await verifyServiceProgram(spec);
  await context.service.backend.install(spec);
  const shouldStart = context.flags.start === true && (journal?.service_was_running ?? true);
  if (shouldStart) {
    await context.service.backend.enable(spec);
    await context.service.backend.start(spec);
    await waitForDaemonReady(context, DEFAULT_WAIT_MS);
  }
  const recovered: UpdateJournal = {
    schema_version: 1,
    phase: "recovered",
    profile: context.profile,
    service_was_running: journal?.service_was_running ?? false,
    prepared_at: journal?.prepared_at ?? new Date().toISOString(),
    recovered_at: new Date().toISOString()
  };
  await writeJsonAtomic(context.paths.updateJournal, recovered);
  return { value: { ok: true, recovered: true, started: shouldStart } };
}

async function runDaemonCommand(context: CliContext, action: string | undefined): Promise<CommandResult> {
  const selected = action ?? "run";
  if (selected === "run") {
    const exitCode = await context.runForegroundDaemon([
      "--home", context.home,
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
    const application = await tryDaemonStatus(context.paths.socket);
    return { value: { service, application: application ?? { ready: false } } };
  }
  if (!["start", "stop", "restart"].includes(selected)) {
    throw new Error("daemon action must be install, uninstall, run, start, stop, restart, or status");
  }
  if (selected === "stop") {
    await context.service.backend.stop(spec);
    await waitForDaemonStopped(context, 15_000);
    return { value: { ok: true, action: "stop", service: await context.service.backend.inspect(spec) } };
  }
  if (context.flags.waitOnline) throw new Error("Worker cloud connections are no longer built in");
  await verifyServiceProgram(spec);
  if (selected === "restart") {
    await context.service.backend.restart(spec);
  } else {
    await context.service.backend.start(spec);
  }
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

async function installDaemonService(context: CliContext): Promise<CommandResult> {
  return withSetupLock(context.paths, async () => {
    await loadInstalledRuntime(context);
    const autostart = context.flags.noAutostart !== true;

    const homeConfiguration = await readJsonFile<RuntimeHomeConfiguration>(context.paths.rootConfig);
    assertHomeConfiguration(homeConfiguration);
    if (!homeConfiguration) throw new Error("Runtime Home config is missing; run octo-runtime login first");
    const spec = context.service.spec(context.paths, autostart);
    await verifyServiceProgram(spec);
    const probe = await context.service.backend.probe();
    if (!probe.supported) {
      throw new Error(`${probe.manager} is unavailable: ${probe.detail ?? "unsupported user session"}`);
    }
    await context.service.backend.install(spec);
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

async function loadInstalledRuntime(context: CliContext): Promise<void> {
  const homeConfiguration = await readJsonFile<RuntimeHomeConfiguration>(context.paths.rootConfig);
  if (!homeConfiguration) throw new Error("Runtime Home is not configured; run octo-runtime login first");
  assertHomeConfiguration(homeConfiguration);
}

async function runAdapterConnectCommand(context: CliContext, adapterType: string | undefined): Promise<CommandResult> {
  if (adapterType !== "openclaw") throw new Error(`adapter connect is not supported for ${adapterType ?? "a missing adapter type"}`);
  return withSetupLock(context.paths, async () => {
    await loadInstalledRuntime(context);
    const result = await configureRuntimeOpenClaw(context);
    return { value: { ok: true, profile: context.profile, ...result } };
  });
}

async function configureRuntimeOpenClaw(context: CliContext): Promise<Record<string, unknown>> {
  for (const flag of ["bindingId", "agentId", "workspace"]) {
    if (context.flags[flag] !== undefined) throw new Error("OpenClaw connections do not accept binding, Agent or workspace settings; select provider_agent_id in Context");
  }
  if (context.flags.tokenStdin && context.flags.enrollTokenStdin) throw new Error("enrollment and Gateway tokens cannot share stdin; use OPENCLAW_GATEWAY_TOKEN for login");
  const input: OpenClawConnectionInput = {};
  if (context.flags.openclawHome !== undefined) input.openclawHome = requiredFlag(context.flags.openclawHome, "openclaw-home");
  if (context.flags.gatewayUrl !== undefined) input.url = requiredFlag(context.flags.gatewayUrl, "gateway-url");
  if (context.flags.tokenStdin === true) input.token = await readSecret(context.input, "OpenClaw Gateway token");
  if (input.url !== undefined && input.token === undefined) input.token = context.env.OPENCLAW_GATEWAY_TOKEN;
  if (input.token !== undefined && input.url === undefined) input.url = context.env.OPENCLAW_GATEWAY_URL;
  const connection = await configureOpenClawConnection(context.paths.profileRoot, input, context.env);
  const probe = await createOpenClawAdapter().probe({ providerOptions: { [OPENCLAW_RUNTIME_ROOT]: context.paths.profileRoot } });
  return { source: connection.source, available: probe.available, ...(probe.reason ? { reason: probe.reason } : {}) };
}

async function readSecret(input: NodeJS.ReadableStream, label: string): Promise<string> {
  let value = "";
  for await (const chunk of input) {
    value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(value) > 64 * 1024) throw new Error(`${label} input is too large`);
  }
  value = value.trim();
  if (!value) throw new Error(`stdin must contain one ${label}`);
  return value;
}

async function runDoctor(context: CliContext): Promise<CommandResult> {
  const checks: Array<Record<string, unknown>> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(check("node.version", nodeMajor >= 24, `Node.js ${process.versions.node}`, "Install Node.js 24 or newer"));
  const homeConfig = await inspectJson<RuntimeHomeConfiguration>(context.paths.rootConfig);
  checks.push(check("home.config", homeConfig.ok, homeConfig.detail, "Run octo-runtime login"));
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

function daemonRequest(group: string, action: string | undefined, id: string | undefined, flags: Flags): CliRequest {
  if (group === "status") return { method: "status" };
  if (group === "extra" && action === "status") return { method: "extra.status" };
  if (group === "extra" && (action === "load" || action === "unload"))
    return { method: `extra.${action}`, params: { name: required(id, "extra-name") } };
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") {
    return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  }
  if (group === "agent-run" && action === "get") {
    return { method: "agent_run.get", params: { run_id: required(id, "run-id") } };
  }
  if (group === "agent-run" && action === "cancel") {
    return {
      method: "agent_run.cancel",
      params: {
        run_id: required(id, "run-id"),
        reason: optionalString(flags.reason) ?? "cancelled_by_operator"
      }
    };
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
    const argument = args[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const rawKey = argument.slice(2, separator < 0 ? undefined : separator);
    const normalizedKey = rawKey.replace(/[-_]([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const key = normalizedKey === "agentIdentit" ? "agentIdentity" : normalizedKey;
    if (["force", "timeoutMs", "waitDrained"].includes(key)) throw new Error(`unknown option --${rawKey}`);
    if ((key === "agentIdentity" || key === "agentName") && Object.hasOwn(flags, key)) throw new Error(`duplicate --${rawKey}`);
    if (BOOLEAN_FLAGS.has(key)) {
      if (separator >= 0) throw new Error(`--${rawKey} does not accept a value`);
      flags[key] = true;
      continue;
    }
    const next = args[index + 1];
    flags[key] = separator >= 0 ? argument.slice(separator + 1) : next && !next.startsWith("--") ? args[++index] : true;
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
    enabled
  );
}

function enumFlag<const TValue extends string>(
  value: FlagValue | undefined,
  allowed: readonly TValue[],
  fallback: TValue
): TValue {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value as TValue)) {
    throw new Error(`value must be one of: ${allowed.join(", ")}`);
  }
  return value as TValue;
}

function helpText(group?: string): string {
  if (group === "channel") {
    return `Usage: octo-runtime [--home PATH] channel configure < bot.json\n\n` +
      `Read one Bot object from stdin and add or replace it in the im.json array by platform, server and bot_id.\n` +
      `Fields: type, api_url, bot_id, bot_name, bf_token, adapter. bot_name defaults to bot_id; enabled defaults to true.\n` +
      `adapter: adapter_type (default codex), absolute workdir, optional model/effort.\n` +
      `OpenClaw: adapter_type=openclaw, optional provider_agent_id (default main), no workdir.\n` +
      `After saving, run daemon run in the foreground or daemon restart for an installed native service.`;
  }
  if (group === "playboard") {
    return `Usage: octo-runtime playboard [--manifest PATH] [--home PATH] [--profile NAME] < request.json\n\n` +
      `For development, testing, and integration debugging only.\n` +
      `Do not integrate production applications by spawning this CLI subcommand.\n\n` +
      `Read one complete JSON request from stdin, spawn an independent Host, and stream NDJSON HostFrames.\n` +
      `No login, Access, Worker, or daemon is required. This runs real providers.\n` +
      `Required: inputs (ModelInputPart[]), contexts (Context v3 envelope).\n` +
      `Optional: sessionId, protocol_mode (native by default, or canonical), agentSource, providerSession, continuityMode.\n` +
      `Defaults: codex, current working directory, approval ask, 120-second run timeout.\n` +
      `OpenClaw defaults: existing main agent, preset source, provider-owned workspace.\n` +
      `Execution settings are overridden by contexts. Pending interactions fail explicitly in this one-shot mode.\n` +
      `--manifest selects an adapter manifest; defaults to the bundled adapters.\n` +
      `See apps/cli/README.md for a complete here-string example.`;
  }
  if (group === "login") {
    return "Usage: octo-runtime [--home PATH] [--profile NAME] login\n\nInitialize the local Runtime Home. Worker enrollment is maintained only in the standalone archive.\nInstaller update modes: --prepare-update | --recover-update [--start]";
  }
  if (group === "daemon") {
    return `Usage: octo-runtime [--home PATH] daemon install|uninstall|run|start|stop|restart|status [options]\n\n` +
      `  install [--no-autostart]\n` +
      `  uninstall\n` +
      `  run [--quiet] [--verbose]\n` +
      `  start\n` +
      `  stop\n` +
      `  restart\n\n` +
      `Uninstall removes the native service but preserves Runtime Home identity, credentials, databases, and logs.`;
  }
  if (group === "doctor") {
    return `Usage: octo-runtime [--home PATH] [--profile NAME] doctor\n\n` +
      `Checks Node.js, local Home configuration, the native user service and daemon IPC.`;
  }
  if (group === "status") {
    return `Usage: octo-runtime [--home PATH] status\n\n` +
      `Reads the daemon's local application status over IPC. Use 'daemon status' to include native service state.`;
  }
  if (group === "adapter") {
    return `Usage: octo-runtime [--home PATH] [--profile NAME] adapter list\n` +
      `       octo-runtime [--home PATH] [--profile NAME] adapter probe <adapter-type>\n` +
      `       octo-runtime [--home PATH] --profile NAME adapter connect openclaw [--openclaw-home PATH | --gateway-url URL --token-stdin]\n\n` +
      `adapter connect saves a Runtime-local OpenClaw connection and probes its availability. Select provider_agent_id in Context.\n` +
      `Connect requires a logged-in Runtime profile. Tokens are read from stdin or OPENCLAW_GATEWAY_TOKEN and stored separately. Without flags, reuse the saved connection or discover OPENCLAW_HOME / ~/.openclaw.`;
  }
  if (group === "agent-run") {
    return `Usage: octo-runtime [--home PATH] agent-run get|cancel [agent-run-id] [options]\n\n` +
      `  cancel <agent-run-id> [--reason TEXT]`;
  }
  if (group === "extraset") return "Usage: octo-runtime [--home PATH] extraset <name> < config.json\n\nWrites the complete {module, enabled?, config} object; restart the daemon to apply. Configuration and tokens are never echoed.";
  if (group === "extra") return "Usage: octo-runtime [--home PATH] extra status|load|unload [name]\n\nUses the declarations read at startup. Restart after extraset to apply new configuration.";
  return `Octo Runtime CLI\n\n` +
    `Global: --home PATH; --profile NAME; --verbose\n\n` +
    `  octo-runtime login --help\n` +
    `  octo-runtime playboard < request.json\n` +
    `  octo-runtime channel configure < bot.json\n` +
    `  octo-runtime extraset <name> < config.json\n` +
    `  octo-runtime extra status|load|unload [name]\n` +
    `  octo-runtime daemon install|uninstall|run|start|stop|restart|status\n` +
    `  octo-runtime doctor [--json]\n` +
    `  octo-runtime status\n` +
    `  octo-runtime adapter list\n` +
    `  octo-runtime adapter probe <type>\n` +
    `  octo-runtime adapter connect openclaw [--openclaw-home PATH | --gateway-url URL --token-stdin]\n` +
    `  octo-runtime agent-run get|cancel ID`;
}

export function runtimeFingerprint(): string {
  return createHash("sha256")
    .update([hostname(), osPlatform(), release(), arch()].join("\0"))
    .digest("hex");
}

export type { ServiceBackend };
