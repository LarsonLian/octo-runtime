import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

interface AdapterHostIdentity {
  pid: number;
  started: string;
  entrypoint: string;
}

export interface InvocationManifestEntry {
  invocationId: string;
  runId: string;
  adapterType: string;
  startedAt: string;
}

interface ManifestFile {
  schemaVersion: 1;
  daemonPid: number;
  updatedAt: string;
  adapterHost?: AdapterHostIdentity;
  invocations: InvocationManifestEntry[];
}

export interface OrphanReapResult {
  found: boolean;
  reaped: boolean;
  pid?: number;
  reason?: "daemon_alive" | "host_missing" | "identity_mismatch" | "unsupported_identity";
}

export class InvocationManifest {
  readonly #path: string;
  readonly #invocations = new Map<string, InvocationManifestEntry>();
  #adapterHost?: AdapterHostIdentity;
  #writes = Promise.resolve();

  private constructor(path: string) {
    this.#path = path;
  }

  static async open(
    path: string
  ): Promise<{ manifest: InvocationManifest; reap: OrphanReapResult }> {
    const reap = await reapOrphanedInvocationManifest(path);
    if (reap.reason === "daemon_alive" || reap.reason === "unsupported_identity") {
      throw new Error(`cannot replace live or unverifiable invocation manifest (${reap.reason})`);
    }
    const manifest = new InvocationManifest(path);
    await manifest.#persist();
    return { manifest, reap };
  }

  async setAdapterHost(pid: number | undefined, entrypoint: string): Promise<void> {
    if (pid === undefined) {
      this.#adapterHost = undefined;
    } else {
      const started = await processStartIdentity(pid);
      if (!started) throw new Error(`cannot identify adapter-host process ${pid}`);
      this.#adapterHost = { pid, started, entrypoint };
    }
    await this.#persist();
  }

  async begin(entry: Omit<InvocationManifestEntry, "startedAt">): Promise<void> {
    this.#invocations.set(entry.invocationId, { ...entry, startedAt: new Date().toISOString() });
    await this.#persist();
  }

  async end(invocationId: string): Promise<void> {
    if (!this.#invocations.delete(invocationId)) return;
    await this.#persist();
  }

  async close(): Promise<void> {
    await this.#writes;
    await rm(this.#path, { force: true });
  }

  #persist(): Promise<void> {
    const snapshot: ManifestFile = {
      schemaVersion: 1,
      daemonPid: process.pid,
      updatedAt: new Date().toISOString(),
      ...(this.#adapterHost ? { adapterHost: { ...this.#adapterHost } } : {}),
      invocations: [...this.#invocations.values()].map((entry) => ({ ...entry }))
    };
    this.#writes = this.#writes.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    return this.#writes;
  }
}

export async function reapOrphanedInvocationManifest(path: string): Promise<OrphanReapResult> {
  let parsed: ManifestFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as ManifestFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { found: false, reaped: false };
    await rm(path, { force: true });
    return { found: true, reaped: false, reason: "host_missing" };
  }
  if (
    Number.isSafeInteger(parsed.daemonPid) &&
    parsed.daemonPid > 0 &&
    processAlive(parsed.daemonPid)
  ) {
    return { found: true, reaped: false, reason: "daemon_alive" };
  }
  const host = parsed.adapterHost;
  if (!host || !Number.isSafeInteger(host.pid) || host.pid < 1 || !processAlive(host.pid)) {
    await rm(path, { force: true });
    return { found: true, reaped: false, reason: "host_missing" };
  }
  const currentIdentity = await processStartIdentity(host.pid);
  if (!currentIdentity) {
    return { found: true, reaped: false, pid: host.pid, reason: "unsupported_identity" };
  }
  if (currentIdentity !== host.started) {
    await rm(path, { force: true });
    return { found: true, reaped: false, pid: host.pid, reason: "identity_mismatch" };
  }
  await terminateProcessGroup(host.pid);
  await rm(path, { force: true });
  return { found: true, reaped: true, pid: host.pid };
}

export async function processStartIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "darwin" || process.platform === "freebsd") {
    return new Promise((resolve) => {
      execFile(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(pid)],
        { timeout: 2_000 },
        (error, stdout) => {
          const value = stdout.trim();
          resolve(error || !value ? undefined : `ps:${value}`);
        }
      );
    });
  }
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`
        ],
        { timeout: 2_000, windowsHide: true },
        (error, stdout) => {
          const value = stdout.trim();
          resolve(error || !/^\d+$/.test(value) ? undefined : `windows:${value}`);
        }
      );
    });
  }
  return undefined;
}

async function terminateProcessGroup(pid: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForExit(pid, 1_000)) return;
  signalProcessGroup(pid, "SIGKILL");
  await waitForExit(pid, 1_000);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processAlive(pid);
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
