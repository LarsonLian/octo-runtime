import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import net from "node:net";
import { arch, hostname, platform as osPlatform, release } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ServiceBackend } from "@mininglamp-oss/octo-harness-cross-service";
import {
  OPENCLAW_PROVIDER_OPTIONS,
  OpenClawGatewayClient,
  createOpenClawDeviceIdentity
} from "@mininglamp-oss/octo-harness-adapter-openclaw";
import {
  exchangeRuntimeEnrollment,
  normalizeServerUrl,
  registerEnrolledRuntime,
  type EnrollmentResult
} from "./enrollment.js";
import { resolveServiceControl, verifyServiceProgram, type ServiceControlOptions } from "./service-control.js";
import {
  defaultHarnessHome,
  defaultOpenClawRunnerAgentId,
  ensureMachineIdentity,
  assertHomeConfiguration,
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
const LEGACY_OPENCLAW_RUNNER_AGENT_ID = "octo-openclaw-runner";
const BOOLEAN_FLAGS = new Set([
  "enrollTokenStdin",
  "force",
  "follow",
  "help",
  "json",
  "noAutostart",
  "tokenStdin",
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
  if (group === "adapter" && action === "setup") return runAdapterSetupCommand(context, id);
  if (group === "adapter" && action === "connect") return runAdapterConnectCommand(context, id);
  // Compatibility for the pre-setup command shape. It is intentionally absent from help output.
  if (group === "adapter" && action === "openclaw") return runOpenClawAdapterCommand(context, id);
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
      machineId: machine.machine_id,
      runtimeKey: identity?.runtime_key,
      runtimeToken: credential?.access_token,
      agentWorkUrl: resolvedAgentWorkUrl,
      fetchImplementation: context.fetchImplementation
    };
    const result = await exchangeRuntimeEnrollment(enrollmentOptions);
    // Enrollment already created the durable Runtime identity and credential.
    // Persist them before registration so a retry can prove and reuse that identity.
    ({ identity, profileConfig } = await persistEnrollment(context, serverUrl, result, runtimeName));
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

  await reconcileHomeConfiguration(context.paths, context.profile, channel);
  await removeIfPresent(context.paths.updateJournal);
  return {
    value: {
      ok: true,
      enrolled,
      profile: context.profile,
      runtime_key: identity.runtime_key,
      server_url: profileConfig.server_url
    }
  };
}

async function persistEnrollment(
  context: CliContext,
  serverUrl: string,
  result: EnrollmentResult,
  runtimeName: string
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
    runtime_key: result.runtimeKey,
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

async function runOpenClawAdapterCommand(context: CliContext, action: string | undefined): Promise<CommandResult> {
  if (action !== "configure" && action !== "init") {
    throw new Error("unknown OpenClaw adapter command; use configure or init");
  }
  assertExplicitSetupProfile(context);
  return withSetupLock(context.paths, async () => {
    const { identity, profileConfig } = await loadInstalledRuntime(context);
    await prepareHarnessDirectories(context.paths);
    return action === "configure"
      ? configureOpenClawAdapter(context, identity, profileConfig)
      : initializeOpenClawAdapter(context, profileConfig);
  });
}

async function runAdapterSetupCommand(context: CliContext, adapterType: string | undefined): Promise<CommandResult> {
  if (adapterType !== "openclaw") {
    throw new Error(`adapter setup is not supported for ${adapterType ?? "a missing adapter type"}`);
  }
  assertExplicitSetupProfile(context);
  return withSetupLock(context.paths, async () => {
    const installed = await loadInstalledRuntime(context);
    const { identity } = installed;
    let { profileConfig } = installed;
    await prepareHarnessDirectories(context.paths);
    const configureRequested = [
      context.flags.gatewayUrl,
      context.flags.tokenStdin,
      context.flags.agentId,
      context.flags.workspace
    ].some(value => value !== undefined);
    if (!profileConfig.adapters?.openclaw || configureRequested) {
      if (!configureRequested) {
        throw new Error("first OpenClaw setup requires --gateway-url URL and --token-stdin");
      }
      await configureOpenClawAdapter(context, identity, profileConfig);
      const configured = await readJsonFile<ProfileConfiguration>(context.paths.profileConfig);
      if (!configured) throw new Error("OpenClaw setup could not reload the saved profile configuration");
      profileConfig = configured;
    }
    if (context.flags.agentId === undefined) {
      profileConfig = await migrateLegacyOpenClawRunnerConfiguration(context, identity, profileConfig);
    }
    const initialized = await initializeOpenClawAdapter(context, profileConfig);
    return {
      ...initialized,
      value: {
        ...(objectValue(initialized.value) ?? {}),
        configured: configureRequested
      }
    };
  });
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
    const agentId = requiredFlag(context.flags.agentId, "agent-id");
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
    throw new Error("adapter setup/connect requires an explicit --profile that has completed login");
  }
}

async function configureOpenClawAdapter(
  context: CliContext,
  runtimeIdentity: RuntimeIdentity,
  profileConfig: ProfileConfiguration
): Promise<CommandResult> {
  const gatewayUrl = normalizeOpenClawGatewayUrl(requiredFlag(context.flags.gatewayUrl, "gateway-url"));
  if (context.flags.tokenStdin !== true) throw new Error("OpenClaw configuration requires --token-stdin");
  const token = await readSecret(context.input, "OpenClaw Gateway token");
  const configuredAgentId = profileConfig.adapters?.openclaw?.agent_id;
  const agentId = optionalString(context.flags.agentId)
    ?? (configuredAgentId && !isDeprecatedOpenClawRunnerAgentId(configuredAgentId)
      ? configuredAgentId
      : defaultOpenClawRunnerAgentId(runtimeIdentity.runtime_key));
  if (!isValidOpenClawAgentId(agentId)) {
    throw new Error("--agent-id must be 1-64 characters and contain lowercase letters, digits, underscores, or hyphens");
  }
  const url = new URL(gatewayUrl);
  const localGateway = isLoopbackHost(url.hostname);
  const requestedWorkspace = optionalString(context.flags.workspace);
  if (!localGateway && !requestedWorkspace) {
    throw new Error("remote OpenClaw Gateway configuration requires --workspace with a path on the Gateway host");
  }
  const localWorkspaceRoot = context.paths.openclawRoot;
  if (localGateway && requestedWorkspace) {
    const candidate = resolve(requestedWorkspace);
    const relativeWorkspace = relative(localWorkspaceRoot, candidate);
    if (relativeWorkspace.startsWith("..") || isAbsolute(relativeWorkspace)) {
      throw new Error(`local OpenClaw runner workspace must stay under ${localWorkspaceRoot}`);
    }
  }
  const workspace = requestedWorkspace
    ? (localGateway ? resolve(requestedWorkspace) : requestedWorkspace)
    : join(localWorkspaceRoot, `${agentId}.workspace`);
  const existingCredential = await readJsonFile<OpenClawGatewayCredential>(context.paths.openclawCredential);
  const identity = existingCredential?.schema_version === 1
    ? {
        deviceId: existingCredential.device_id,
        publicKey: existingCredential.public_key,
        privateKey: existingCredential.private_key
      }
    : createOpenClawDeviceIdentity();
  const credential: OpenClawGatewayCredential = {
    schema_version: 1,
    access_token: token,
    device_id: identity.deviceId,
    public_key: identity.publicKey,
    private_key: identity.privateKey,
    issued_at: new Date().toISOString(),
    provider_options: {
      [OPENCLAW_PROVIDER_OPTIONS.token]: token,
      [OPENCLAW_PROVIDER_OPTIONS.deviceId]: identity.deviceId,
      [OPENCLAW_PROVIDER_OPTIONS.publicKey]: identity.publicKey,
      [OPENCLAW_PROVIDER_OPTIONS.privateKey]: identity.privateKey
    }
  };
  const updated: ProfileConfiguration = {
    ...profileConfig,
    adapters: {
      ...profileConfig.adapters,
      openclaw: {
        schema_version: 1,
        gateway_url: gatewayUrl,
        agent_id: agentId,
        workspace,
        credential_ref: "credentials/openclaw-gateway.json",
        execution: {
          provider_agent_id: agentId,
          provider_options: {
            [OPENCLAW_PROVIDER_OPTIONS.url]: gatewayUrl,
            [OPENCLAW_PROVIDER_OPTIONS.workspace]: workspace
          },
          credential_ref: "credentials/openclaw-gateway.json",
          managed_workspace: {
            path: workspace,
            root: "adapters/openclaw",
            active_when_url: gatewayUrl,
            require_empty: true,
            require_read_only: true
          }
        }
      }
    }
  };
  await writeJsonAtomic(context.paths.openclawCredential, credential);
  await writeJsonAtomic(context.paths.profileConfig, updated);
  return {
    value: {
      ok: true,
      profile: context.profile,
      gateway_url: gatewayUrl,
      agent_id: agentId,
      workspace,
      credential: "stored separately",
      next: `octo-harness --profile ${context.profile} adapter setup openclaw`
    }
  };
}

async function migrateLegacyOpenClawRunnerConfiguration(
  context: CliContext,
  runtimeIdentity: RuntimeIdentity,
  profileConfig: ProfileConfiguration
): Promise<ProfileConfiguration> {
  const openclaw = profileConfig.adapters?.openclaw;
  if (!openclaw) return profileConfig;

  const agentId = defaultOpenClawRunnerAgentId(runtimeIdentity.runtime_key);
  const legacyWorkspace = resolve(context.paths.openclawRoot, "octo-runner.workspace");
  const localGateway = isLoopbackHost(new URL(openclaw.gateway_url).hostname);
  const hasDeprecatedAgentId = isDeprecatedOpenClawRunnerAgentId(openclaw.agent_id);
  const hasLegacyLocalWorkspace = localGateway && resolve(openclaw.workspace) === legacyWorkspace;
  if (!hasDeprecatedAgentId
      && !(openclaw.agent_id === agentId && hasLegacyLocalWorkspace)) return profileConfig;
  if (!localGateway) {
    throw new Error("remote OpenClaw legacy runner migration requires setup with explicit --agent-id and a new --workspace");
  }

  const workspace = join(context.paths.openclawRoot, `${agentId}.workspace`);
  const migrated: ProfileConfiguration = {
    ...profileConfig,
    adapters: {
      ...profileConfig.adapters,
      openclaw: {
        ...openclaw,
        agent_id: agentId,
        workspace,
        execution: {
          ...openclaw.execution,
          provider_agent_id: agentId,
          provider_options: {
            ...openclaw.execution.provider_options,
            [OPENCLAW_PROVIDER_OPTIONS.workspace]: workspace
          },
          managed_workspace: openclaw.execution.managed_workspace
            ? {
                ...openclaw.execution.managed_workspace,
                path: workspace
              }
            : undefined
        }
      }
    }
  };
  await writeJsonAtomic(context.paths.profileConfig, migrated);
  return migrated;
}

function isDeprecatedOpenClawRunnerAgentId(agentId: string): boolean {
  return agentId === LEGACY_OPENCLAW_RUNNER_AGENT_ID
    || agentId.startsWith(`${LEGACY_OPENCLAW_RUNNER_AGENT_ID}-`)
    || (agentId.startsWith("octo-runner-") && !agentId.startsWith("octo-runner-run-"));
}

async function initializeOpenClawAdapter(
  context: CliContext,
  profileConfig: ProfileConfiguration
): Promise<CommandResult> {
  const configuration = profileConfig.adapters?.openclaw;
  if (!configuration) throw new Error("OpenClaw adapter is not configured; run adapter setup openclaw with Gateway options first");
  const credential = await readJsonFile<OpenClawGatewayCredential>(context.paths.openclawCredential);
  if (!credential || credential.schema_version !== 1 || !credential.access_token || !credential.device_id || !credential.public_key || !credential.private_key) {
    throw new Error(`OpenClaw Gateway credential is missing or invalid: ${context.paths.openclawCredential}`);
  }
  const url = new URL(configuration.gateway_url);
  const localGateway = isLoopbackHost(url.hostname);
  if (localGateway) {
    await mkdir(configuration.workspace, { recursive: true, mode: 0o700 });
    if ((await lstat(configuration.workspace)).isSymbolicLink()) {
      throw new Error(`OpenClaw runner workspace must not be a symbolic link: ${configuration.workspace}`);
    }
    const managedRoot = await realpath(join(context.paths.profileRoot, "adapters", "openclaw"));
    const actualWorkspace = await realpath(configuration.workspace);
    const relativeWorkspace = relative(managedRoot, actualWorkspace);
    if (relativeWorkspace.startsWith("..") || isAbsolute(relativeWorkspace)) {
      throw new Error(`OpenClaw runner workspace resolves outside its managed root: ${configuration.workspace}`);
    }
    if (process.platform !== "win32") await chmod(configuration.workspace, 0o700);
  }
  const client = new OpenClawGatewayClient({
    url: configuration.gateway_url,
    token: credential.access_token,
    device: {
      deviceId: credential.device_id,
      publicKey: credential.public_key,
      privateKey: credential.private_key
    }
  });
  try {
    const hello = await client.connect();
    if (hello.protocol !== 4) throw new Error(`unsupported OpenClaw Gateway protocol: ${hello.protocol}`);
    assertOpenClawGatewayCapabilities(hello.features);
    if (hello.auth?.deviceToken && hello.auth.deviceToken !== credential.access_token) {
      await writeJsonAtomic(context.paths.openclawCredential, {
        ...credential,
        access_token: hello.auth.deviceToken,
        issued_at: new Date().toISOString(),
        provider_options: {
          ...credential.provider_options,
          [OPENCLAW_PROVIDER_OPTIONS.token]: hello.auth.deviceToken
        }
      } satisfies OpenClawGatewayCredential);
    }
    const listed = objectValue(await client.request("agents.list", {}));
    const agents = Array.isArray(listed?.agents) ? listed.agents.map(objectValue).filter(Boolean) : [];
    const existing = agents.find(agent => agent?.id === configuration.agent_id || agent?.agentId === configuration.agent_id);
    if (!existing) {
      await client.request("agents.create", {
        name: configuration.agent_id,
        workspace: configuration.workspace
      });
    } else {
      const existingWorkspace = optionalUnknownString(existing.workspace);
      const workspaceMatches = !existingWorkspace
        || (localGateway
          ? resolve(existingWorkspace) === resolve(configuration.workspace)
          : existingWorkspace === configuration.workspace);
      if (!workspaceMatches) {
        throw new Error(`OpenClaw agent ${configuration.agent_id} already uses a different workspace: ${existingWorkspace}`);
      }
    }

    const snapshot = objectValue(await client.request("config.get", {}));
    const baseHash = optionalUnknownString(snapshot?.hash);
    if (!baseHash) throw new Error("OpenClaw config.get did not return a writable base hash");
    await client.request("config.patch", {
      raw: JSON.stringify({
        agents: {
          // OpenClaw exposes bootstrap file creation only as a Gateway-wide default.
          // Without this, sessions.create.cwd pollutes every fresh Harness workdir.
          defaults: { skipBootstrap: true },
          entries: {
            [configuration.agent_id]: {
              name: configuration.agent_id,
              workspace: configuration.workspace,
              skills: [],
              contextInjection: "never",
              // Harness invocations are unattended. OpenClaw's ask_user runtime
              // pauses only on OpenClaw surfaces, which Octo cannot answer.
              tools: { deny: ["group:memory", "ask_user"] },
              memory: { search: { rememberAcrossConversations: false } }
            }
          }
        }
      }),
      baseHash,
      replacePaths: [`agents.entries.${configuration.agent_id}.skills`]
    });

    let workspaceMode = "remote-owner-must-enforce-read-only";
    if (localGateway) {
      await emptyGeneratedOpenClawWorkspace(configuration.workspace);
      if (process.platform !== "win32") await chmod(configuration.workspace, 0o555);
      if ((await readdir(configuration.workspace)).length > 0) {
        throw new Error(`OpenClaw runner workspace is not empty after initialization: ${configuration.workspace}`);
      }
      if (process.platform !== "win32" && ((await stat(configuration.workspace)).mode & 0o222) !== 0) {
        throw new Error(`OpenClaw runner workspace remains writable after initialization: ${configuration.workspace}`);
      }
      workspaceMode = "empty-read-only";
    }
    return {
      value: {
        ok: true,
        profile: context.profile,
        gateway_url: configuration.gateway_url,
        agent_id: configuration.agent_id,
        workspace: configuration.workspace,
        workspace_mode: workspaceMode,
        gateway_skip_bootstrap: true,
        gateway_scope_warning: "agents.defaults.skipBootstrap affects every agent on this Gateway; use a dedicated Gateway for Octo isolation",
        context_injection: "never",
        skills: [],
        memory: "disabled-for-runner"
      }
    };
  } finally {
    try {
      await client.close();
    } finally {
      if (localGateway && process.platform !== "win32") {
        await chmod(configuration.workspace, 0o555);
      }
    }
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

function assertOpenClawGatewayCapabilities(features: unknown): void {
  const value = objectValue(features);
  const methods = Array.isArray(value?.methods) ? value.methods : [];
  const events = Array.isArray(value?.events) ? value.events : [];
  for (const method of ["sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort", "agents.list", "agents.create", "config.get", "config.patch"]) {
    if (!methods.includes(method)) throw new Error(`OpenClaw Gateway does not advertise required method ${method}`);
  }
  if (!events.includes("agent")) throw new Error("OpenClaw Gateway does not advertise the agent event stream");
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

async function emptyGeneratedOpenClawWorkspace(workspace: string): Promise<void> {
  const allowed = new Set(["AGENTS.md", "BOOTSTRAP.md", "HEARTBEAT.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md"]);
  const entries = await readdir(workspace, { withFileTypes: true });
  const unexpected = entries.filter(entry => {
    if (entry.isFile() && allowed.has(entry.name)) return false;
    return !(entry.isDirectory() && entry.name === ".git");
  });
  if (unexpected.length > 0) {
    throw new Error(`refusing to empty OpenClaw runner workspace because it contains unexpected entries: ${unexpected.map(entry => entry.name).join(", ")}`);
  }
  await Promise.all(entries.map(entry => rm(resolve(workspace, entry.name), {
    force: true,
    recursive: entry.isDirectory()
  })));
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

function optionalUnknownString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const agentWork = selectedRuntimeStatus(application, identity.value?.runtime_key);
  if (agentWork?.enabled === true) {
    checks.push(check(
      "runtime.cloud",
      agentWork.connected === true,
      agentWork.connected === true ? `online as ${String(agentWork.runtimeKey)}` : "not connected",
      "Inspect daemon logs and verify the server credential"
    ));
  }
  const ok = checks.every(item => item.ok === true);
  return { value: { ok, profile: context.profile, home: context.home, checks }, exitCode: ok ? 0 : 1 };
}

function daemonRequest(group: string, action: string | undefined, id: string | undefined, flags: Flags): CliRequest {
  if (group === "status") return { method: "status" };
  if (group === "diagnostics" && action === undefined) return { method: "diagnostics.bundle" };
  if (group === "logs" && action === "path") return { method: "logs.path" };
  if (group === "logs" && action === "query") {
    const limit = optionalString(flags.limit);
    return {
      method: "logs.query",
      params: {
        ...(optionalString(flags.requestId) ? { requestId: optionalString(flags.requestId) } : {}),
        ...(id ? { runKey: id } : {}),
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
      : { method: "agent_session.get", params: { agentSessionKey: required(id, "agent-session-id") } };
  }
  if (group === "events") {
    if (action !== undefined) throw new Error("events accepts filters as flags, not positional arguments");
    return {
      method: "events.subscribe",
      params: {
        ...(optionalString(flags.runKey) ? { runKey: optionalString(flags.runKey) } : {}),
        ...(optionalString(flags.source) ? { source: optionalString(flags.source) } : {}),
        follow: flags.follow === true
      }
    };
  }
  if (group === "agent-run" && action && ["list", "get", "wait"].includes(action)) {
    return action === "list"
      ? { method: "agent_run.list" }
      : { method: `agent_run.${action}`, params: { runKey: required(id, "agent-run-id") } };
  }
  if (group === "agent-run" && action === "cancel") {
    return {
      method: "agent_run.cancel",
      params: {
        runKey: required(id, "agent-run-id"),
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
  const runKey = typeof record.run_key === "string" ? ` run=${record.run_key}` : "";
  const color = process.stdout.isTTY ? sourceColor(source) : "";
  const reset = color ? "\u001b[0m" : "";
  return `${color}[${source}]${reset} ${type}${runKey} ${JSON.stringify(record.payload)}`;
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
    const agentWork = selectedRuntimeStatus(last, identity.runtime_key);
    if (last?.ready === true && agentWork?.connected === true && agentWork.runtimeKey === identity.runtime_key) return last;
    await context.sleep(100);
  }
  const agentWork = selectedRuntimeStatus(last, identity.runtime_key);
  throw new Error(
    `runtime ${identity.runtime_key} did not become cloud-online within ${timeoutMs}ms (connected=${agentWork?.connected === true})`
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

function validateIdentity(value: RuntimeIdentity, profile: string): void {
  if (value.schema_version !== 1 || value.profile !== profile || !value.runtime_key || !value.credential_id || "system_id" in value || "device_id" in value) {
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
  runtimeKey: string | undefined
): Record<string, unknown> | undefined {
  const agentWork = objectValue(application?.agentWork);
  if (!agentWork) return undefined;
  if (!runtimeKey || agentWork.runtimeKey === runtimeKey) return agentWork;
  const runtimes = Array.isArray(agentWork.runtimes) ? agentWork.runtimes : [];
  return runtimes
    .map(objectValue)
    .find(status => status?.runtimeKey === runtimeKey);
}

function helpText(group?: string): string {
  if (group === "login") {
    return `Usage: octo-harness [--home PATH] [--profile NAME] login [options]\n\n` +
      `First login:\n` +
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
      `  query [RUN_ID] [--request-id ID] [--invocation ID] [--limit N] [--sensitive]\n` +
      `Application data is read through daemon IPC; use doctor for service startup failures.`;
  }
  if (group === "diagnostics") {
    return `Usage: octo-harness [--home PATH] diagnostics\n\n` +
      `Builds a metadata-only support bundle. It excludes credentials, prompts, model output, tool I/O, provider I/O, outbox payloads, and filesystem paths.`;
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
    return `Usage: octo-harness [--home PATH] [--profile NAME] adapter list\n` +
      `       octo-harness [--home PATH] [--profile NAME] adapter probe <adapter-type>\n` +
      `       octo-harness [--home PATH] --profile NAME adapter setup openclaw [--gateway-url URL --token-stdin] [--agent-id ID] [--workspace PATH]\n\n` +
      `       octo-harness [--home PATH] --profile NAME adapter connect openclaw --binding-id ID --gateway-url URL --agent-id ID --workspace PATH --token-stdin\n\n` +
      `adapter connect pairs an existing OpenClaw Agent as a black-box external binding; it never creates or patches that Agent.\n` +
      `Only OpenClaw currently needs setup for the legacy managed local runner; the setup command is retained for compatibility.\n` +
      `Setup requires an explicit, already logged-in Harness profile. Tokens are read from stdin and stored separately from profile config.`;
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
    `  octo-harness daemon install|uninstall|run|start|stop|restart|status\n` +
    `  octo-harness doctor [--json]\n` +
    `  octo-harness status\n` +
    `  octo-harness diagnostics\n` +
    `  octo-harness adapter list\n` +
    `  octo-harness adapter probe <type>\n` +
    `  octo-harness adapter setup openclaw\n` +
    `  octo-harness adapter connect openclaw --binding-id ID --gateway-url URL --agent-id ID --workspace PATH --token-stdin\n` +
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
