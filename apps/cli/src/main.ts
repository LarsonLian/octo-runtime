import {
  OPENCLAW_PROVIDER_OPTIONS,
  OpenClawGatewayClient,
  createOpenClawDeviceIdentity
} from "@mininglamp-oss/octo-harness-adapter-openclaw";
import type { ServiceBackend } from "@mininglamp-oss/octo-harness-cross-service";
import { createHash, randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import net from "node:net";
import { arch, hostname, platform as osPlatform, release } from "node:os";
import {
  exchangeRuntimeEnrollment,
  normalizeServerUrl,
  registerEnrolledRuntime,
  type EnrollmentResult
} from "./enrollment.js";
import { resolveServiceControl, verifyServiceProgram, type ServiceControlOptions } from "./service-control.js";
import {
  assertHomeConfiguration,
  defaultHarnessHome,
  ensureMachineIdentity,
  harnessPaths,
  isValidOpenClawAgentId,
  migrateLegacyProfileLayout,
  prepareHarnessDirectories,
  readJsonFile,
  reconcileHomeConfiguration,
  removeIfPresent,
  withSetupLock,
  writeJsonAtomic,
  type HarnessHomeConfiguration,
  type HarnessPaths,
  type OpenClawGatewayCredential,
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
  "help",
  "json",
  "noAutostart",
  "tokenStdin",
  "prepareUpdate",
  "quiet",
  "recoverUpdate",
  "start",
  "verbose",
  "waitDrained",
  "waitOnline"
]);

export async function runCli(args: string[], dependencies: CliDependencies = {}): Promise<number> {
  const normalizedArgs = [...args];
  if (normalizedArgs[0] === "--") normalizedArgs.shift();
  const { positionals, flags } = parseArguments(normalizedArgs);
  if (positionals[0] === "playboard" && flags.help !== true) {
    if (positionals.length !== 1 || Object.keys(flags).some(key => key !== "manifest")) {
      throw new Error("playboard accepts only --manifest PATH; pass the request JSON on stdin");
    }
    const { runPlayboard } = await import("./playboard.js");
    return runPlayboard({
      input: dependencies.input ?? process.stdin,
      output: dependencies.output,
      env: dependencies.env,
      manifest: flags.manifest === undefined ? undefined : requiredFlag(flags.manifest, "manifest")
    });
  }
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
  if (group === "adapter" && action === "connect") return runAdapterConnectCommand(context, id);
  if (group === "daemon") return runDaemonCommand(context, action);
  if (group === "doctor") return runDoctor(context);
  const request = daemonRequest(group, action, id, context.flags);
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
  const agentIdentity = optionalString(context.flags.agentIdentity) ?? profileConfig?.agent_identity ?? "main";
  const agentName = optionalString(context.flags.agentName) ?? profileConfig?.agent_name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(agentIdentity)) throw new Error("invalid --agent-identity");
  if (agentName !== undefined && (!agentName || agentName.trim() !== agentName || Buffer.byteLength(agentName) > 255)) throw new Error("invalid --agent-name");
  let enrolled = false;
  const enrollmentToken = context.flags.enrollTokenStdin === true
    ? await readEnrollmentToken(context.input)
    : undefined;

  if (!identity || enrollmentToken) {
    if (identity) {
      validateIdentity(identity, context.profile);
      if (!profileConfig) throw new Error(`profile config is missing: ${context.paths.profileConfig}`);
      validateProfileConfiguration(profileConfig, context.profile);
    }
    const requestedServerUrl = optionalString(context.flags.serverUrl) ?? profileConfig?.server_url;
    if (!requestedServerUrl) throw new Error("first login requires --server-url");
    if (!enrollmentToken) throw new Error("first login requires --enroll-token-stdin");
    const serverUrl = normalizeServerUrl(requestedServerUrl);
    const requestedAgentWorkUrl = optionalString(context.flags.agentWorkUrl);
    const serverChanged = Boolean(identity && profileConfig && serverUrl !== profileConfig.server_url);
    const agentWorkUrl = requestedAgentWorkUrl
      ?? (serverChanged ? undefined : profileConfig?.agent_work_url);
    const resolvedAgentWorkUrl = normalizeServerUrl(agentWorkUrl ?? `${serverUrl}/agentworker/api`);
    const runtimeName = optionalString(context.flags.runtimeName)
      ?? profileConfig?.runtime_name
      ?? (hostname() || "Octo Harness Runtime");
    const machine = await ensureMachineIdentity(context.paths);
    const credential = identity ? await readJsonFile<RuntimeCredential>(context.paths.credential) : undefined;
    if (identity && !credential?.access_token) {
      throw new Error("existing profile re-enrollment requires its Runtime credential");
    }
    const enrollmentOptions = {
      serverUrl,
      enrollmentToken,
      profile: context.profile,
      runtimeName,
      agentIdentity, agentName,
      machineId: machine.machine_id,
      runtimeId: identity?.runtime_id,
      runtimeToken: credential?.access_token,
      agentWorkUrl: resolvedAgentWorkUrl,
      fetchImplementation: context.fetchImplementation
    };
    const result = await exchangeRuntimeEnrollment(enrollmentOptions);
    // Enrollment already created the durable Runtime identity and credential.
    // Persist them before registration so a retry can prove and reuse that identity.
    ({ identity, profileConfig } = await persistEnrollment(context, serverUrl, result, runtimeName, agentIdentity, agentName));
    await registerEnrolledRuntime(enrollmentOptions, result);
    enrolled = true;
  } else {
    validateIdentity(identity, context.profile);
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

  if (!enrolled && (context.flags.agentIdentity !== undefined || context.flags.agentName !== undefined)) {
    profileConfig = { ...profileConfig, agent_identity: agentIdentity, ...(agentName ? { agent_name: agentName } : {}) };
    await writeJsonAtomic(context.paths.profileConfig, profileConfig);
    const credential = await readJsonFile<RuntimeCredential>(context.paths.credential);
    await registerEnrolledRuntime({ serverUrl: profileConfig.server_url, enrollmentToken: "", profile: context.profile, runtimeName: profileConfig.runtime_name, machineId: "", agentIdentity, agentName, agentWorkUrl: profileConfig.agent_work_url, fetchImplementation: context.fetchImplementation }, {
      profile: context.profile, runtimeId: identity.runtime_id, credentialId: identity.credential_id, accessToken: credential?.access_token, agentWorkUrl: profileConfig.agent_work_url
    });
  }
  await reconcileHomeConfiguration(context.paths, context.profile, channel);
  await removeIfPresent(context.paths.updateJournal);
  return {
    value: {
      ok: true,
      enrolled,
      profile: context.profile,
      runtime_id: identity.runtime_id,
      agent_identity: agentIdentity,
      server_url: profileConfig.server_url
    }
  };
}

async function persistEnrollment(
  context: CliContext,
  serverUrl: string,
  result: EnrollmentResult,
  runtimeName: string,
  agentIdentity: string,
  agentName?: string
): Promise<{ identity: RuntimeIdentity; profileConfig: ProfileConfiguration }> {
  const now = new Date().toISOString();
  const previousProfileConfig = await readJsonFile<ProfileConfiguration>(context.paths.profileConfig);
  const agentWorkUrl = result.agentWorkUrl ? normalizeServerUrl(result.agentWorkUrl) : undefined;
  if (agentWorkUrl && !result.accessToken) {
    throw new Error("Agent Work enrollment requires agent_work_url and runtime access token together");
  }
  const identity: RuntimeIdentity = {
    schema_version: 1,
    profile: result.profile,
    runtime_id: result.runtimeId,
    credential_id: result.credentialId,
    ...(result.octoSpaceId ? { octo_space_id: result.octoSpaceId } : {}),
    enrolled_at: now
  };
  const profileConfig: ProfileConfiguration = {
    schema_version: 1,
    profile: context.profile,
    server_url: serverUrl,
    ...(agentWorkUrl ? { agent_work_url: agentWorkUrl } : {}),
    ...(result.octoSpaceId ? { octo_space_id: result.octoSpaceId } : {}),
    runtime_name: runtimeName,
    agent_identity: agentIdentity,
    ...(agentName ? { agent_name: agentName } : {}),
    ...(previousProfileConfig?.adapters ? { adapters: previousProfileConfig.adapters } : {})
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
  validateIdentity(identity, context.profile);

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

/**
 * Pair an already-existing OpenClaw Agent as an external black-box Agent.
 * This path deliberately does not create an Agent or patch Gateway config.
 */
async function runAdapterConnectCommand(context: CliContext, adapterType: string | undefined): Promise<CommandResult> {
  if (adapterType !== "openclaw") {
    throw new Error(`adapter connect is not supported for ${adapterType ?? "a missing adapter type"}`);
  }
  assertExplicitSetupProfile(context);
  return withSetupLock(context.paths, async () => {
    const installed = await loadInstalledRuntime(context);
    await prepareHarnessDirectories(context.paths);
    const bindingId = requiredFlag(context.flags.bindingId, "binding-id");
    const gatewayUrl = normalizeOpenClawGatewayUrl(requiredFlag(context.flags.gatewayUrl, "gateway-url"));
    const agentId = context.flags.agentId === undefined ? "main" : requiredFlag(context.flags.agentId, "agent-id");
    const workspace = requiredFlag(context.flags.workspace, "workspace");
    if (!isValidOpenClawAgentId(agentId)) {
      throw new Error("--agent-id must be 1-64 characters and contain lowercase letters, digits, underscores, or hyphens");
    }
    if (context.flags.tokenStdin !== true) throw new Error("OpenClaw external binding requires --token-stdin");
    const token = await readSecret(context.input, "OpenClaw Gateway token");
    const existingCredential = await readJsonFile<OpenClawGatewayCredential>(context.paths.openclawCredential);
    const device = existingCredential?.schema_version === 1
      ? { deviceId: existingCredential.device_id, publicKey: existingCredential.public_key, privateKey: existingCredential.private_key }
      : createOpenClawDeviceIdentity();
    const client = new OpenClawGatewayClient({
      url: gatewayUrl,
      token,
      device: { deviceId: device.deviceId, publicKey: device.publicKey, privateKey: device.privateKey }
    });
    try {
      const hello = await client.connect();
      if (hello.protocol !== 4) throw new Error(`unsupported OpenClaw Gateway protocol: ${hello.protocol}`);
      assertOpenClawExternalCapabilities(hello.features);
      const listed = objectValue(await client.request("agents.list", {}));
      const agents = Array.isArray(listed?.agents) ? listed.agents.map(objectValue).filter(Boolean) : [];
      const existing = agents.find(agent => agent?.id === agentId || agent?.agentId === agentId);
      if (!existing) throw new Error(`OpenClaw Agent ${agentId} was not found; external binding refuses to create it`);
      const rotatedToken = hello.auth?.deviceToken ?? token;
      const credential: OpenClawGatewayCredential = {
        schema_version: 1,
        access_token: rotatedToken,
        device_id: device.deviceId,
        public_key: device.publicKey,
        private_key: device.privateKey,
        issued_at: new Date().toISOString(),
        provider_options: {
          [OPENCLAW_PROVIDER_OPTIONS.token]: rotatedToken,
          [OPENCLAW_PROVIDER_OPTIONS.deviceId]: device.deviceId,
          [OPENCLAW_PROVIDER_OPTIONS.publicKey]: device.publicKey,
          [OPENCLAW_PROVIDER_OPTIONS.privateKey]: device.privateKey
        }
      };
      const profileConfig = installed.profileConfig;
      const updated: ProfileConfiguration = {
        ...profileConfig,
        adapters: {
          ...profileConfig.adapters,
          openclaw: {
            schema_version: 1,
            kind: "external",
            binding_id: bindingId,
            gateway_url: gatewayUrl,
            agent_id: agentId,
            workspace,
            credential_ref: "credentials/openclaw-gateway.json",
            execution: {
              provider_agent_id: agentId,
              provider_options: {
                [OPENCLAW_PROVIDER_OPTIONS.url]: gatewayUrl,
                [OPENCLAW_PROVIDER_OPTIONS.workspace]: workspace,
                [OPENCLAW_PROVIDER_OPTIONS.bindingId]: bindingId
              },
              credential_ref: "credentials/openclaw-gateway.json"
            }
          }
        }
      };
      await writeJsonAtomic(context.paths.openclawCredential, credential);
      await writeJsonAtomic(context.paths.profileConfig, updated);
      return {
        value: {
          ok: true,
          kind: "external",
          binding_id: bindingId,
          profile: context.profile,
          gateway_url: gatewayUrl,
          agent_id: agentId,
          workspace,
          verified: true,
          control: "black-box; OpenClaw owns Agent configuration"
        }
      };
    } finally {
      await client.close();
    }
  });
}

function assertExplicitSetupProfile(context: CliContext): void {
  if (!optionalString(context.flags.profile)) {
    throw new Error("adapter connect requires an explicit --profile that has completed login");
  }
}

function normalizeOpenClawGatewayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("--gateway-url must use ws:// or wss://");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("--gateway-url must not embed credentials, query parameters, or fragments");
  }
  if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
    throw new Error("remote OpenClaw Gateway URLs must use wss://");
  }
  return url.toString();
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function assertOpenClawExternalCapabilities(features: unknown): void {
  const value = objectValue(features);
  const methods = Array.isArray(value?.methods) ? value.methods : [];
  const events = Array.isArray(value?.events) ? value.events : [];
  for (const method of ["agents.list", "sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort"]) {
    if (!methods.includes(method)) throw new Error(`OpenClaw Gateway does not advertise required external binding method ${method}`);
  }
  if (!events.includes("agent")) throw new Error("OpenClaw Gateway does not advertise the agent event stream");
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
  if (group === "adapter" && action === "list") return { method: "adapter.list" };
  if (group === "adapter" && action === "probe") {
    return { method: "adapter.probe", params: { adapterType: required(id, "adapter-type") } };
  }
  if (group === "agent-session" && action && ["list", "get"].includes(action)) {
    return action === "list"
      ? { method: "agent_session.list" }
      : { method: "agent_session.get", params: { agentSessionId: required(id, "agent-session-id") } };
  }
  if (group === "agent-run" && action && ["list", "get", "wait"].includes(action)) {
    return action === "list"
      ? { method: "agent_run.list" }
      : { method: `agent_run.${action}`, params: { runId: required(id, "agent-run-id") } };
  }
  if (group === "agent-run" && action === "cancel") {
    return {
      method: "agent_run.cancel",
      params: {
        runId: required(id, "agent-run-id"),
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

function validateIdentity(value: RuntimeIdentity, profile: string): void {
  if (value.schema_version !== 1 || value.profile !== profile || !value.runtime_id || !value.credential_id || "system_id" in value || "device_id" in value) {
    throw new Error("runtime identity is invalid; refusing automatic re-enrollment");
  }
}

function validateProfileConfiguration(value: ProfileConfiguration, profile: string): void {
  if (value.schema_version !== 1 || value.profile !== profile || !value.server_url) {
    throw new Error("profile config is invalid");
  }
  const openclaw = value.adapters?.openclaw;
  if (openclaw && (openclaw.schema_version !== 1 || !openclaw.gateway_url || !openclaw.agent_id || !openclaw.workspace
    || openclaw.credential_ref !== "credentials/openclaw-gateway.json"
    || (openclaw.kind === "external" && !openclaw.binding_id))) {
    throw new Error("profile OpenClaw adapter config is invalid");
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
    const separator = argument.indexOf("=");
    const rawKey = argument.slice(2, separator < 0 ? undefined : separator);
    const normalizedKey = rawKey.replace(/[-_]([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const key = normalizedKey === "agentIdentit" ? "agentIdentity" : normalizedKey;
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
  const configuration = await readJsonFile<HarnessHomeConfiguration>(context.paths.rootConfig);
  assertHomeConfiguration(configuration);
  return context.service.spec(
    context.paths,
    enabled
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
  if (group === "playboard") {
    return `Usage: octo-harness playboard [--manifest PATH] < request.json\n\n` +
      `Read one complete JSON request from stdin, spawn an independent Host, and stream NDJSON HostFrames.\n` +
      `No login, Access, Worker, or daemon is required. This runs real providers.\n` +
      `Required: inputs (ModelInputPart[]), contexts (Context v3 envelope).\n` +
      `Optional: sessionId, protocolMode (native by default, or canonical), agentSource, providerSession, continuityMode.\n` +
      `Defaults: codex, current working directory, approval ask, 120-second run timeout.\n` +
      `Execution settings are overridden by contexts. Pending interactions fail explicitly in this one-shot mode.\n` +
      `--manifest selects an adapter manifest; defaults to the bundled adapters.\n` +
      `See apps/cli/README.md for a complete here-string example.`;
  }
  if (group === "login") {
    return `Usage: octo-harness [--home PATH] [--profile NAME] login [options]\n\n` +
      `First login:\n` +
      `  --agent-identity ID   Agent identity (default: main); also --agent-identit\n` +
      `  --agent-name NAME     Initial display name; also --agent_name\n` +
      `  --server-url URL --enroll-token-stdin [--agent-work-url URL]\n\n` +
      `  --agent-work-url is the Worker API root and defaults to SERVER_URL/agentworker/api.\n\n` +
      `Installer-only update modes:\n` +
      `  --prepare-update [--wait-drained] [--timeout-ms MS]\n` +
      `  --recover-update [--start]\n\n` +
      `Login only writes Runtime identity and credentials. Service lifecycle uses 'daemon install' and 'daemon start'.\n\n` +
      `Profiles are for trusted identities of the same OS user; use separate OS users/homes for isolation.`;
  }
  if (group === "daemon") {
    return `Usage: octo-harness [--home PATH] daemon install|uninstall|run|start|stop|restart|status [options]\n\n` +
      `  install [--no-autostart]\n` +
      `  uninstall [--force] [--timeout-ms MS]\n` +
      `  run [--quiet] [--verbose]\n` +
      `  start [--wait-online] [--timeout-ms MS]\n` +
      `  stop|restart [--force] [--wait-online] [--timeout-ms MS]\n\n` +
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
  if (group === "adapter") {
    return `Usage: octo-harness [--home PATH] [--profile NAME] adapter list\n` +
      `       octo-harness [--home PATH] [--profile NAME] adapter probe <adapter-type>\n` +
      `       octo-harness [--home PATH] --profile NAME adapter connect openclaw --binding-id ID --gateway-url URL [--agent-id ID] --workspace PATH --token-stdin\n\n` +
      `adapter connect pairs an existing OpenClaw Agent as a black-box external binding; it never creates or patches that Agent.\n` +
      `Connect requires an explicit, already logged-in Harness profile. Tokens are read from stdin and stored separately from profile config.`;
  }
  if (group === "agent-session") {
    return `Usage: octo-harness [--home PATH] agent-session list|get <agent-session-id>`;
  }
  if (group === "agent-run") {
    return `Usage: octo-harness [--home PATH] agent-run list|get|wait|cancel [agent-run-id] [options]\n\n` +
      `  cancel <agent-run-id> [--reason TEXT]`;
  }
  return `Octo Harness CLI\n\n` +
    `Global: --home PATH; --profile NAME; --verbose\n\n` +
    `  octo-harness login --help\n` +
    `  octo-harness playboard < request.json\n` +
    `  octo-harness daemon install|uninstall|run|start|stop|restart|status\n` +
    `  octo-harness doctor [--json]\n` +
    `  octo-harness status\n` +
    `  octo-harness adapter list\n` +
    `  octo-harness adapter probe <type>\n` +
    `  octo-harness adapter connect openclaw --binding-id ID --gateway-url URL [--agent-id ID] --workspace PATH --token-stdin\n` +
    `  octo-harness agent-session list|get ID\n` +
    `  octo-harness agent-run list|get|wait|cancel ID`;
}

export function runtimeFingerprint(): string {
  return createHash("sha256")
    .update([hostname(), osPlatform(), release(), arch()].join("\0"))
    .digest("hex");
}

export type { ServiceBackend };
