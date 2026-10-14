import type { DaemonModule, DaemonModuleContext } from "@mininglamp-oss/octo-runtime-daemon";
import { resetTenantEnrollment, ensureTenantEnrollment, type WorkerTenant } from "./enrollment.js";
import { AgentWorkSupervisor } from "./agent-work-supervisor.js";
import type { AgentWorkRuntimeOptions } from "./agent-work-runtime.js";
import { loadManagedAgentWorksFromRoot } from "./managed-profile.js";
import { join } from "node:path";

export interface WorkerAccessModuleConfig {
  runtimes?: AgentWorkRuntimeOptions[];
  registrations?: Array<WorkerTenant & { humanToken: string }>;
}

/** Executed inside daemon, using the same Host as local and IM runs. */
export function createWorkerAccessModule(
  context: DaemonModuleContext,
  input: unknown
): DaemonModule {
  const config = input as WorkerAccessModuleConfig;
  if (
    !config ||
    typeof config !== "object" ||
    (config.runtimes !== undefined && !Array.isArray(config.runtimes)) ||
    (config.registrations !== undefined && !Array.isArray(config.registrations))
  )
    throw new Error("WORKER_ACCESS_CONFIG_INVALID");
  let supervisor: AgentWorkSupervisor | undefined;
  let stopped = false;
  return {
    get status() {
      return supervisor?.status ?? { enabled: false, runtimes: [] };
    },
    async start() {
      for (const registration of config.registrations ?? []) {
        context.signal.throwIfAborted();
        const account = context.account;
        const profile = account?.profiles.find((item) => item.tenantId === registration.id);
        if (!account || !profile) throw new Error("TENANT_NOT_ACTIVE");
        if (typeof registration.humanToken !== "string" || !registration.humanToken)
          throw new Error("HUMAN_TOKEN_MISSING");
        await ensureTenantEnrollment({
          subject: account.subject,
          tenant: registration,
          machine: { schema_version: 1, machine_id: account.machineId },
          profile: {
            name: profile.profile,
            root: profile.root,
            configFile: join(profile.root, "config.json"),
            identityFile: join(profile.root, "identity", "runtime.json"),
            credentialFile: join(profile.root, "credentials", "runtime-token.json")
          },
          getHumanToken: () => registration.humanToken,
          signal: context.signal
        });
      }
      context.signal.throwIfAborted();
      if (stopped) return;
      const runtimes =
        config.runtimes ??
        (context.account
          ? loadManagedAgentWorksFromRoot(
              context.homePath,
              context.account.profiles.map((profile) => profile.profile)
            )
          : []);
      if (
        context.account &&
        runtimes.some(
          (runtime) =>
            !context.account!.profiles.some(
              (profile) =>
                profile.runtimeId === runtime.runtimeId && profile.profile === runtime.profile
            )
        )
      )
        throw new Error("WORKER_RUNTIME_NOT_ACTIVE");
      supervisor = new AgentWorkSupervisor(runtimes, context.host);
      await supervisor.start();
    },
    async handle(request) {
      if (request.method !== "reset") throw new Error("WORKER_ACCESS_METHOD_NOT_FOUND");
      const profile = context.account?.profiles.find(
        (item) => item.tenantId === request.params?.tenantId
      );
      if (!profile) throw new Error("TENANT_NOT_ACTIVE");
      await supervisor?.close();
      supervisor = undefined;
      resetTenantEnrollment({
        name: profile.profile,
        root: profile.root,
        configFile: join(profile.root, "config.json"),
        identityFile: join(profile.root, "identity", "runtime.json"),
        credentialFile: join(profile.root, "credentials", "runtime-token.json")
      });
      return { reset: true };
    },
    beginDrain() {
      supervisor?.beginDrain();
    },
    async waitForDrained(timeoutMs) {
      await supervisor?.waitForDrained(timeoutMs);
    },
    async close() {
      stopped = true;
      await supervisor?.close();
    }
  };
}
