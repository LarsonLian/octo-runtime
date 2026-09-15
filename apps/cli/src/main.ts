import { createHash, randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import net from "node:net";
import { arch, hostname, platform as osPlatform, release } from "node:os";
import type { ServiceBackend } from "@mininglamp-oss/octo-harness-cross-service";
import {
  enrollRuntime,
  normalizeServerUrl,
  type EnrollmentResult
} from "./enrollment.js";
import { resolveServiceControl, verifyServiceProgram, type ServiceControlOptions } from "./service-control.js";
import {
  defaultHarnessHome,
  assertHomeConfiguration,
  harnessPaths,
  migrateLegacyProfileLayout,
  prepareHarnessDirectories,
  readJsonFile,
  reconcileHomeConfiguration,
  removeIfPresent,
  withSetupLock,
  writeJsonAtomic,
  type HarnessHomeConfiguration,
  type HarnessPaths,
  type ProfileConfiguration,
  type RuntimeCredential,
  type RuntimeIdentity,
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
  home: string;
  profile: string;
  paths: HarnessPaths;
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
  "force",
  "follow",
  "help",
  "json",
  "noAutostart",
  "prepareUpdate",
  "quiet",
  "recoverUpdate",
  "sensitive",
  "start",
  "verbose",
  "waitDrained",
  "waitOnline"
]);

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const normalizedArgs = [...args];
  if (normalizedArgs[0] === "--") normalizedArgs.shift();
  const { positionals, flags } = parseArguments(normalizedArgs);
  const profile = optionalString(flags.profile) ?? "default";
  const home = optionalString(flags.home) ?? defaultHarnessHome(dependencies.env, dependencies.platform);
  const paths = harnessPaths(home, profile);
  const output = dependencies.output ?? (value => process.stdout.write(`${value}\n`));
  const context: CliContext = {
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
      process.argv = [process.execPath, originalArgv[1] ?? "octo-harness", ...daemonArgs];
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
  if (group === "login") return runLogin(context);
  if (group === "daemon") return runDaemonCommand(context, action);
  if (group === "doctor") return runDoctor(context);
  if (group === "inspect") {
    if (action !== undefined || context.flags.noOpen !== undefined) {
      throw new Error("unknown command; run octo-harness help");
    }
    const result = await callDaemon<{ url: string }>(context.paths.socket, { method: "inspect.info" });
    return { value: result.url };
  }

  const request = daemonRequest(group, action, id, context.flags);
  if (request.method === "events.subscribe") {
    await streamDaemon(context.paths.socket, request, context.output, context.flags.json === true);
    return { streamed: true };
  }
  return { value: await callDaemon(context.paths.socket, request) };
}

async function runLogin(context: CliContext): Promise<CommandResult> {
  return withSetupLock(context.paths, async () => {
    const homeConfiguration = await readJsonFile<HarnessHomeConfiguration>(context.paths.rootConfig);
    assertHomeConfiguration(homeConfiguration);
    if (context.flags.prepareUpdate === true && context.flags.recoverUpdate === true) {
      throw new Error("--prepare-update and --recover-update are mutually exclusive update modes");
    }
    if (context.flags.prepareUpdate === true) {
      await prepareHarnessDirectories(context.paths);
      return prepareUpdate(context);
    }
    if (context.flags.recoverUpdate === true) {
      await prepareHarnessDirectories(context.paths);
      return recoverUpdate(context);
    }
    await migrateLegacyProfileLayout(
      context.paths,
      Boolean(await tryDaemonStatus(context.paths.socket))
    );
    await prepareHarnessDirectories(context.paths);
    return reconcileSetup(context);
  });
}

async function reconcileSetup(context: CliContext): Promise<CommandResult> {
  const channel = enumFlag(context.flags.channel, ["stable", "beta"] as const, "stable");
  let identity = await readJsonFile<RuntimeIdentity>(context.paths.identity);
  let profileConfig = await readJsonFile<ProfileConfiguration>(context.paths.profileConfig);
  let enrolled = false;
  const enrollmentToken = context.flags.enrollTokenStdin === true
    ? await readEnrollmentToken(context.input)
    : undefined;

  if (!identity || enrollmentToken) {
    if (identity) validateIdentity(identity);
    const requestedServerUrl = optionalString(context.flags.serverUrl) ?? profileConfig?.server_url;
    if (!requestedServerUrl) throw new Error("first login requires --server-url");
    if (!enrollmentToken) throw new Error("first login requires --enroll-token-stdin");
    const serverUrl = normalizeServerUrl(requestedServerUrl);
    const runtimeName = optionalString(context.flags.runtimeName)
      ?? profileConfig?.runtime_name
      ?? (hostname() || "Octo Harness Runtime");
    const systemId = identity?.system_id ?? `system_${randomUUID()}`;
    const result = await enrollRuntime({
      serverUrl,
      enrollmentToken,
      profile: context.profile,
      runtimeName,
      systemId,
      agentWorkUrl: optionalString(context.flags.agentWorkUrl) ?? profileConfig?.agent_work_url,
      fetchImplementation: context.fetchImplementation
    });
    if (identity && result.runtimeId !== identity.runtime_id) {
      throw new Error("re-enrollment returned a different runtime for the existing system identity");
    }
    ({ identity, profileConfig } = await persistEnrollment(context, serverUrl, systemId, result, runtimeName));
    enrolled = true;
  } else {
    validateIdentity(identity);
    if (!profileConfig) throw new Error(`profile config is missing: ${context.paths.profileConfig}`);
    validateProfileConfiguration(profileConfig, context.profile);
    const requestedServer = optionalString(context.flags.serverUrl);
    if (requestedServer && normalizeServerUrl(requestedServer) !== profileConfig.server_url) {
      throw new Error("this profile is already enrolled with a different server; use another trusted profile or re-enroll explicitly");
    }
    const agentWorkUrl = optionalString(context.flags.agentWorkUrl);
    if (agentWorkUrl && normalizeServerUrl(agentWorkUrl) !== profileConfig.agent_work_url) {
      throw new Error("this profile is already bound to a different Agent Worker; re-enroll with a fresh token");
    }
  }

  await reconcileHomeConfiguration(context.paths, context.profile, channel);
  await removeIfPresent(context.paths.updateJournal);
  return {
    value: {
      ok: true,
      enrolled,
      profile: context.profile,
      runtime_id: identity.runtime_id,
      server_url: profileConfig.server_url
    }
  };
}

async function persistEnrollment(
  context: CliContext,
  serverUrl: string,
  systemId: string,
  result: EnrollmentResult,
  runtimeName: string
): Promise<{ identity: RuntimeIdentity; profileConfig: ProfileConfiguration }> {
  const now = new Date().toISOString();
  const agentWorkUrl = result.agentWorkUrl ? normalizeServerUrl(result.agentWorkUrl) : undefined;
  if (agentWorkUrl && (!result.tenantId || !result.subjectId || !result.accessToken)) {
    throw new Error("Agent Work enrollment requires agent_work_url, tenant_id, subject_id, and runtime access token together");
  }
  const identity: RuntimeIdentity = {
    schema_version: 1,
    runtime_id: result.runtimeId,
    credential_id: result.credentialId,
    system_id: systemId,
    ...(result.deviceId ? { device_id: result.deviceId } : {}),
    ...(result.workspaceId ? { workspace_id: result.workspaceId } : {}),
    ...(result.octoSpaceId ? { octo_space_id: result.octoSpaceId } : {}),
    enrolled_at: now
  };
  const profileConfig: ProfileConfiguration = {
    schema_version: 1,
    profile: context.profile,
    server_url: serverUrl,
    ...(agentWorkUrl ? { agent_work_url: agentWorkUrl } : {}),
    ...(result.tenantId ? { tenant_id: result.tenantId } : {}),
    ...(result.subjectId ? { subject_id: result.subjectId } : {}),
    runtime_name: runtimeName
  };
  const credential: RuntimeCredential = {
    schema_version: 1,
    ...(result.accessToken ? { access_token: result.accessToken } : {}),
    issued_at: now,
    ...(result.expiresAt ? { expires_at: result.expiresAt } : {})
  };
  // Identity is written last so incomplete local state is never treated as enrolled.
  await writeJsonAtomic(context.paths.credential, credential);
  await writeJsonAtomic(context.paths.profileConfig, profileConfig);
  await writeJsonAtomic(context.paths.identity, identity);
  return { identity, profileConfig };
}

async function prepareUpdate(context: CliContext): Promise<CommandResult> {
  const spec = await daemonServiceSpec(context);
  const current = await context.service.backend.inspect(spec);
  const wasRunning = ["running", "starting"].includes(current.state);
  if (wasRunning && context.flags.waitDrained === true) {
    try {
      await callDaemon(context.paths.socket, {
        method: "lifecycle.drain",
        params: { timeoutMs: numericFlag(context.flags.timeoutMs, DEFAULT_WAIT_MS) }
      });
    } catch (error) {
      throw new Error("daemon could not drain before update", { cause: error });
    }
  }
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
  if (!["run", "install"].includes(selected)
    && (context.flags.inspectHost !== undefined || context.flags.inspectPort !== undefined)) {
    throw new Error("--inspect-host and --inspect-port are valid with 'daemon run' or 'daemon install'");
  }
  if (selected === "run") {
    const exitCode = await context.runForegroundDaemon([
      "--home", context.home,
      ...(context.flags.quiet === true ? [] : ["--console"]),
      ...(context.flags.verbose === true ? ["--verbose"] : []),
      ...inspectDaemonArguments(inspectBindingFromFlags(context.flags))
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
    if (context.flags.force !== true && await tryDaemonStatus(context.paths.socket)) {
      await callDaemon(context.paths.socket, {
        method: "lifecycle.drain",
        params: { timeoutMs: numericFlag(context.flags.timeoutMs, DEFAULT_WAIT_MS) }
      });
    }
    await context.service.backend.stop(spec);
    await waitForDaemonStopped(context, numericFlag(context.flags.timeoutMs, 15_000));
    return { value: { ok: true, action: "stop", service: await context.service.backend.inspect(spec) } };
  }
  const onlineRuntime = context.flags.waitOnline === true
    ? await loadInstalledRuntime(context)
    : undefined;
  await verifyServiceProgram(spec);
  if (selected === "restart") {
    if (context.flags.force !== true && await tryDaemonStatus(context.paths.socket)) {
      await callDaemon(context.paths.socket, {
        method: "lifecycle.drain",
        params: { timeoutMs: numericFlag(context.flags.timeoutMs, DEFAULT_WAIT_MS) }
      });
    }
    await context.service.backend.restart(spec);
  } else {
    await context.service.backend.start(spec);
  }
  const readiness = onlineRuntime
    ? await waitForDaemonOnline(context, onlineRuntime.identity, onlineRuntime.profileConfig)
    : await waitForDaemonReady(context, numericFlag(context.flags.timeoutMs, DEFAULT_WAIT_MS));
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

    const homeConfiguration = await readJsonFile<HarnessHomeConfiguration>(context.paths.rootConfig);
    assertHomeConfiguration(homeConfiguration);
    if (!homeConfiguration) throw new Error("Harness Home config is missing; run octo-harness login first");
    const inspectBinding = inspectBindingFromFlags(context.flags, homeConfiguration.inspect);
    const spec = context.service.spec(context.paths, autostart, inspectDaemonArguments(inspectBinding));
    await verifyServiceProgram(spec);
    const probe = await context.service.backend.probe();
    if (!probe.supported) {
      throw new Error(`${probe.manager} is unavailable: ${probe.detail ?? "unsupported user session"}`);
    }
    await context.service.backend.install(spec);
    if (inspectBinding) {
      await writeJsonAtomic(context.paths.rootConfig, { ...homeConfiguration, inspect: inspectBinding });
    }
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
    if (context.flags.force !== true && application && managedProcessActive) {
      await callDaemon(context.paths.socket, {
        method: "lifecycle.drain",
        params: { timeoutMs: numericFlag(context.flags.timeoutMs, DEFAULT_WAIT_MS) }
      });
    }
    await context.service.backend.uninstall(spec);
    if (application && managedProcessActive) {
      await waitForDaemonStopped(context, numericFlag(context.flags.timeoutMs, 15_000));
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

async function loadInstalledRuntime(
  context: CliContext
): Promise<{ identity: RuntimeIdentity; profileConfig: ProfileConfiguration }> {
  const homeConfiguration = await readJsonFile<HarnessHomeConfiguration>(context.paths.rootConfig);
  if (!homeConfiguration) {
    throw new Error(`Harness Home is not configured: ${context.home}; run octo-harness login first`);
  }
  assertHomeConfiguration(homeConfiguration);
  const identity = await readJsonFile<RuntimeIdentity>(context.paths.identity);
  if (!identity) throw new Error(`runtime identity is missing: ${context.paths.identity}; run octo-harness login first`);
  validateIdentity(identity);

  const profileConfig = await readJsonFile<ProfileConfiguration>(context.paths.profileConfig);
  if (!profileConfig) throw new Error(`profile config is missing: ${context.paths.profileConfig}; run octo-harness login first`);
  validateProfileConfiguration(profileConfig, context.profile);

  const credential = await readJsonFile<RuntimeCredential>(context.paths.credential);
  if (!credential || credential.schema_version !== 1 || !credential.issued_at) {
    throw new Error(`runtime credential is missing or invalid: ${context.paths.credential}; run octo-harness login first`);
  }
  if (profileConfig.agent_work_url && !credential.access_token) {
    throw new Error(`runtime access token is missing: ${context.paths.credential}; re-enroll this Harness Home`);
  }
  return { identity, profileConfig };
}

async function runDoctor(context: CliContext): Promise<CommandResult> {
  const checks: Array<Record<string, unknown>> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(check("node.version", nodeMajor >= 24, `Node.js ${process.versions.node}`, "Install Node.js 24 or newer"));
  const profileConfig = await inspectJson<ProfileConfiguration>(context.paths.profileConfig);
  checks.push(check("profile.config", profileConfig.ok, profileConfig.detail, "Run login with a valid enrollment token"));
  const identity = await inspectJson<RuntimeIdentity>(context.paths.identity);
  checks.push(check("runtime.identity", identity.ok, identity.detail, "Run login with a fresh enrollment token"));
  const credential = await inspectJson<RuntimeCredential>(context.paths.credential);
  checks.push(check("runtime.credential", credential.ok, credential.detail, "Re-enroll or restore the credential file"));
  if (process.platform !== "win32" && credential.ok) {
    const file = await stat(context.paths.credential);
    checks.push(check(
      "credential.permissions",
      (file.mode & 0o077) === 0,
      `mode ${(file.mode & 0o777).toString(8)}`,
      `chmod 600 ${context.paths.credential}`
    ));
  }
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
      "Run octo-harness daemon install to reconcile the service definition"
    ));
  }
  const application = await tryDaemonStatus(context.paths.socket);
  checks.push(check("daemon.ipc", Boolean(application), application ? "ready" : "not reachable", "Run octo-harness daemon start"));
  const agentWork = selectedRuntimeStatus(application, identity.value?.runtime_id);
  if (agentWork?.enabled === true) {
    checks.push(check(
      "runtime.cloud",
      agentWork.connected === true,
      agentWork.connected === true ? `online as ${String(agentWork.runtimeId)}` : "not connected",
      "Inspect daemon logs and verify the server credential"
    ));
  }
  const ok = checks.every(item => item.ok === true);
  return { value: { ok, profile: context.profile, home: context.home, checks }, exitCode: ok ? 0 : 1 };
}

function daemonRequest(group: string, action: string | undefined, id: string | undefined, flags: Flags): CliRequest {
  if (group === "status") return { method: "status" };
  if (group === "logs" && action === "path") return { method: "logs.path" };
  if (group === "logs" && action === "query") {
    const limit = optionalString(flags.limit);
    return {
      method: "logs.query",
      params: {
        ...(id ? { runId: id } : {}),
        ...(optionalString(flags.invocation) ? { invocationId: optionalString(flags.invocation) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
        includeSensitive: flags.sensitive === true
      }
    };
  }
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") {
    return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  }
  if (group === "agent-session" && action && ["list", "get"].includes(action)) {
    return action === "list"
      ? { method: "agent_session.list" }
      : { method: "agent_session.get", params: { agentSessionId: required(id, "agent-session-id") } };
  }
  if (group === "events") {
    if (action !== undefined) throw new Error("events accepts filters as flags, not positional arguments");
    return {
      method: "events.subscribe",
      params: {
        ...(optionalString(flags.runId) ? { runId: optionalString(flags.runId) } : {}),
        ...(optionalString(flags.source) ? { source: optionalString(flags.source) } : {}),
        follow: flags.follow === true
      }
    };
  }
  if (group === "agent-run" && action && ["list", "get", "wait"].includes(action)) {
    return action === "list"
      ? { method: "agent_run.list" }
      : { method: `agent_run.${action}`, params: { agentRunId: required(id, "agent-run-id") } };
  }
  if (group === "agent-run" && action === "cancel") {
    return {
      method: "agent_run.cancel",
      params: {
        agentRunId: required(id, "agent-run-id"),
        reason: optionalString(flags.reason) ?? "cancelled_by_operator"
      }
    };
  }
  throw new Error("unknown command; run octo-harness help");
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

async function streamDaemon(
  socketPath: string,
  request: CliRequest,
  output: (value: string) => void,
  json: boolean
): Promise<void> {
  const socket = await connectDaemon(socketPath);
  socket.write(`${JSON.stringify({ id: randomUUID(), ...request })}\n`);
  let done = false;
  try {
    for await (const line of createLines(socket)) {
      const response = JSON.parse(line) as CliResponse;
      if (response.error) throw new Error(response.error.message ?? "daemon stream failed");
      if (response.event !== undefined) output(formatLiveEvent(response.event, json));
      if (response.result !== undefined) {
        done = true;
        break;
      }
    }
    if (!done) throw new Error("daemon stream closed before completion");
  } finally {
    socket.destroy();
  }
}

function formatLiveEvent(value: unknown, json: boolean): string {
  const record = objectValue(value);
  if (json || !record) return JSON.stringify(value);
  const source = typeof record.source === "string" ? record.source : "unknown";
  const type = typeof record.type === "string" ? record.type : "event";
  const runId = typeof record.agent_run_id === "string" ? ` run=${record.agent_run_id}` : "";
  const color = process.stdout.isTTY ? sourceColor(source) : "";
  const reset = color ? "\u001b[0m" : "";
  return `${color}[${source}]${reset} ${type}${runId} ${JSON.stringify(record.payload)}`;
}

function sourceColor(source: string): string {
  const colors: Record<string, string> = {
    daemon: "\u001b[36m",
    "adapter-rpc": "\u001b[35m",
    "provider-native": "\u001b[33m",
    "adapter-canonical": "\u001b[34m",
    "host-canonical": "\u001b[32m",
    runtime: "\u001b[37m",
    worker: "\u001b[36m",
    control: "\u001b[31m"
  };
  return colors[source] ?? "\u001b[37m";
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

async function waitForDaemonOnline(
  context: CliContext,
  identity: RuntimeIdentity,
  profile: ProfileConfiguration
): Promise<Record<string, unknown>> {
  if (!profile.agent_work_url) {
    throw new Error("--wait-online requires agent_work_url from enrollment or --agent-work-url");
  }
  const timeoutMs = numericFlag(context.flags.timeoutMs, DEFAULT_WAIT_MS);
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = await tryDaemonStatus(context.paths.socket);
    const agentWork = selectedRuntimeStatus(last, identity.runtime_id);
    if (last?.ready === true && agentWork?.connected === true && agentWork.runtimeId === identity.runtime_id) return last;
    await context.sleep(100);
  }
  const agentWork = selectedRuntimeStatus(last, identity.runtime_id);
  throw new Error(
    `runtime ${identity.runtime_id} did not become cloud-online within ${timeoutMs}ms (connected=${agentWork?.connected === true})`
  );
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
      throw new Error(`cannot connect to Octo Harness daemon at ${socketPath}; start it with: octo-harness daemon start`, {
        cause: error
      });
    }
    throw error;
  }
  return socket;
}

async function* createLines(socket: net.Socket): AsyncGenerator<string> {
  let buffered = "";
  socket.setEncoding("utf8");
  for await (const chunk of socket) {
    buffered += String(chunk);
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  if (buffered) yield buffered;
}

async function readEnrollmentToken(input: NodeJS.ReadableStream): Promise<string> {
  let value = "";
  for await (const chunk of input) {
    value += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(value) > 16 * 1024) throw new Error("enrollment token input is too large");
  }
  value = value.trim();
  if (!value.startsWith("octo_enroll_") || value.length <= "octo_enroll_".length) {
    throw new Error("stdin must contain one valid octo_enroll_ enrollment token");
  }
  return value;
}

function validateIdentity(value: RuntimeIdentity): void {
  if (value.schema_version !== 1 || !value.runtime_id || !value.credential_id || !value.system_id) {
    throw new Error("runtime identity is invalid; refusing automatic re-enrollment");
  }
}

function validateProfileConfiguration(value: ProfileConfiguration, profile: string): void {
  if (value.schema_version !== 1 || value.profile !== profile || !value.server_url) {
    throw new Error("profile config is invalid");
  }
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
    const key = argument.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[index + 1];
    flags[key] = next && !next.startsWith("--") ? args[++index] : true;
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

interface InspectBinding {
  host: string;
  port?: number;
}

function inspectBindingFromFlags(flags: Flags, fallback?: InspectBinding): InspectBinding | undefined {
  if (flags.inspectHost === undefined && flags.inspectPort === undefined) return fallback;
  const host = flags.inspectHost === undefined
    ? fallback?.host ?? "127.0.0.1"
    : requiredFlag(flags.inspectHost, "inspect-host").trim();
  if (!host || /[\s/]/.test(host) || host.includes("://") || (host.includes(":") && net.isIP(host) !== 6)) {
    throw new Error("--inspect-host must be a hostname or IP address without a scheme, path, or port");
  }
  const rawPort = flags.inspectPort === undefined ? undefined : requiredFlag(flags.inspectPort, "inspect-port");
  const port = rawPort === undefined ? fallback?.port : Number(rawPort);
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("--inspect-port must be an integer between 1 and 65535");
  }
  return { host, ...(port === undefined ? {} : { port }) };
}

function inspectDaemonArguments(binding: InspectBinding | undefined): string[] {
  if (!binding) return [];
  const args: string[] = [];
  args.push("--inspect-host", binding.host);
  if (binding.port !== undefined) args.push("--inspect-port", String(binding.port));
  return args;
}

async function daemonServiceSpec(context: CliContext, enabled = true) {
  const configuration = await readJsonFile<HarnessHomeConfiguration>(context.paths.rootConfig);
  assertHomeConfiguration(configuration);
  return context.service.spec(
    context.paths,
    enabled,
    inspectDaemonArguments(configuration?.inspect)
  );
}

function numericFlag(value: FlagValue | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const numeric = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 1 || numeric > 10 * 60_000) {
    throw new Error("--timeout-ms must be an integer between 1 and 600000");
  }
  return numeric;
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function selectedRuntimeStatus(
  application: Record<string, unknown> | undefined,
  runtimeId: string | undefined
): Record<string, unknown> | undefined {
  const agentWork = objectValue(application?.agentWork);
  if (!agentWork) return undefined;
  if (!runtimeId || agentWork.runtimeId === runtimeId) return agentWork;
  const runtimes = Array.isArray(agentWork.runtimes) ? agentWork.runtimes : [];
  return runtimes
    .map(objectValue)
    .find(status => status?.runtimeId === runtimeId);
}

function helpText(group?: string): string {
  if (group === "login") {
    return `Usage: octo-harness [--home PATH] [--profile NAME] login [options]\n\n` +
      `First login:\n` +
      `  --server-url URL --enroll-token-stdin [--agent-work-url URL]\n\n` +
      `  --agent-work-url defaults to SERVER_URL/agentworker.\n\n` +
      `Installer-only update modes:\n` +
      `  --prepare-update [--wait-drained] [--timeout-ms MS]\n` +
      `  --recover-update [--start]\n\n` +
      `Login only writes Runtime identity and credentials. Service lifecycle uses 'daemon install' and 'daemon start'.\n\n` +
      `Profiles are for trusted identities of the same OS user; use separate OS users/homes for isolation.`;
  }
  if (group === "daemon") {
    return `Usage: octo-harness [--home PATH] daemon install|uninstall|run|start|stop|restart|status [options]\n\n` +
      `  install [--no-autostart] [--inspect-host HOST] [--inspect-port PORT]\n` +
      `  uninstall [--force] [--timeout-ms MS]\n` +
      `  run [--quiet] [--verbose] [--inspect-host HOST] [--inspect-port PORT]\n` +
      `  start [--wait-online] [--timeout-ms MS]\n` +
      `  stop|restart [--force] [--wait-online] [--timeout-ms MS]\n\n` +
      `The inspector defaults to 127.0.0.1 and a random port from 20001 through 65535. Non-loopback hosts expose a capability-protected diagnostic endpoint.\n\n` +
      `Uninstall removes the native service but preserves Harness Home identity, credentials, databases, and logs.`;
  }
  if (group === "doctor") {
    return `Usage: octo-harness [--home PATH] [--profile NAME] doctor\n\n` +
      `Checks Node.js, profile identity and credential protection, the native user service, daemon IPC, and cloud connection.`;
  }
  if (group === "status") {
    return `Usage: octo-harness [--home PATH] status\n\n` +
      `Reads the daemon's local application status over IPC. Use 'daemon status' to include native service state.`;
  }
  if (group === "logs") {
    return `Usage: octo-harness [--home PATH] logs path|query [RUN_ID] [options]\n\n` +
      `  query [RUN_ID] [--invocation ID] [--limit N] [--sensitive]\n` +
      `Application data is read through daemon IPC; use doctor for service startup failures.`;
  }
  if (group === "events") {
    return `Usage: octo-harness [--home PATH] events [--follow] [--run-id ID] [--source SOURCE] [--json]\n\n` +
      `Reads the daemon's bounded in-memory event stream. The default prints the retained snapshot and exits.`;
  }
  if (group === "inspect") {
    return `Usage: octo-harness [--home PATH] inspect\n\n` +
      `Prints the address of the daemon-owned inspector, which listens for the full daemon lifetime.`;
  }
  if (group === "adapter") {
    return `Usage: octo-harness [--home PATH] adapter list|probe <adapter-type>`;
  }
  if (group === "agent-session") {
    return `Usage: octo-harness [--home PATH] agent-session list|get <agent-session-id>`;
  }
  if (group === "agent-run") {
    return `Usage: octo-harness [--home PATH] agent-run list|get|wait|cancel [agent-run-id] [options]\n\n` +
      `  cancel <agent-run-id> [--reason TEXT]`;
  }
  return `Octo Harness CLI\n\n` +
    `Global: --home PATH; --profile NAME (login/doctor selection only); --verbose\n\n` +
    `  octo-harness login --help\n` +
    `  octo-harness daemon install|uninstall|run|start|stop|restart|status\n` +
    `  octo-harness doctor [--json]\n` +
    `  octo-harness status\n` +
    `  octo-harness adapter list|probe <type>\n` +
    `  octo-harness logs path|query [RUN_ID]\n` +
    `  octo-harness events [--follow] [--run-id ID] [--source SOURCE]\n` +
    `  octo-harness inspect\n` +
    `  octo-harness agent-session list|get ID\n` +
    `  octo-harness agent-run list|get|wait|cancel ID`;
}

export function runtimeFingerprint(): string {
  return createHash("sha256")
    .update([hostname(), osPlatform(), release(), arch()].join("\0"))
    .digest("hex");
}

export type { ServiceBackend };
