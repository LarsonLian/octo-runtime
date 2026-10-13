import { compileRunContext } from "@mininglamp-oss/octo-harness-context-builder/run-context";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { AdapterHostRpc } from "@mininglamp-oss/octo-harness-adapter-host";
import { assertContextEnvelope, assertInvokeRequest, type ContextEnvelope, type ProviderSession } from "@mininglamp-oss/octo-harness-protocol";
import { registerBot, WukongConnection, type ImMessage } from "./wukong.js";
export { registerBot, WukongConnection } from "./wukong.js";
export type { ImMessage, BotRegistration } from "./wukong.js";

export interface ImBotConfig {
  id: string;
  apiUrl: string;
  botId: string;
  spaceId: string;
  tokenFile: string;
  adapterType: string;
  workdir: string;
  model?: string;
  context: ContextEnvelope;
  /** Omitted: only the bot owner's direct messages are admitted. */
  allowedSenderIds?: string[];
}
interface Session {
  id: string; generation: number; providerSession?: ProviderSession;
  lastEventId?: string; lastRunId?: string; activeInvocationId?: string;
  pending: number; tail: Promise<void>;
}
export interface ImModuleDependencies { host: AdapterHostRpc }

export function loadImBots(home: string): ImBotConfig[] {
  const file = resolve(home, "im.json");
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const config = JSON.parse(text) as { bots?: ImBotConfig[] };
  if (!Array.isArray(config.bots) || config.bots.length > 16) throw new Error("IM_CONFIG_INVALID");
  const identities = new Set<string>();
  return config.bots.map(bot => {
    if (!bot.id || !bot.botId || !bot.spaceId || !bot.tokenFile || !bot.adapterType || !isAbsolute(bot.workdir)) throw new Error("IM_CONFIG_INVALID");
    const url = new URL(bot.apiUrl);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw new Error("IM_API_URL_INVALID");
    const identity = `${url.origin}:${bot.botId}`;
    if (identities.has(identity)) throw new Error("IM_BOT_DUPLICATED"); identities.add(identity);
    assertContextEnvelope(bot.context);
    return { ...bot, tokenFile: resolve(home, bot.tokenFile) };
  });
}

/** Single-turn IM orchestration; stores only bounded session handles, never chat history. */
export class ImRuntime {
  #connection?: WukongConnection;
  #sessions = new Map<string, Session>();
  #seen = new Map<string, number>();
  #closed = true;
  #online = false;
  #owner = "";
  #reconnect?: NodeJS.Timeout;
  #abort = new AbortController();
  #error?: string;
  #pending = 0;
  constructor(readonly config: ImBotConfig, readonly dependencies: ImModuleDependencies) {}
  get status(): Record<string, unknown> {
    return { id: this.config.id, botId: this.config.botId, connected: this.#online, error: this.#error ?? null,
      sessions: [...this.#sessions].map(([key, value]) => ({ key, sessionId: value.id, generation: value.generation, runId: value.lastRunId, eventId: value.lastEventId, active: !!value.activeInvocationId })) };
  }
  async start(): Promise<void> { this.#closed = false; this.#abort = new AbortController(); await this.#connect(); }
  async #connect(): Promise<void> {
    try {
      const info = statSync(this.config.tokenFile);
      if (process.platform !== "win32" && (info.mode & 0o077)) throw new Error("IM_TOKEN_PERMISSIONS_REQUIRE_0600");
      const token = readFileSync(this.config.tokenFile, "utf8").trim();
      if (!/^bf_[A-Za-z0-9_-]+$/.test(token)) throw new Error("IM_BOT_TOKEN_INVALID");
      const registration = await registerBot(this.config.apiUrl, token, this.#abort.signal);
      if (registration.robot_id !== this.config.botId) throw new Error("IM_BOT_IDENTITY_MISMATCH");
      this.#owner = registration.owner_uid;
      const connection = new WukongConnection(message => this.#receive(message), () => { this.#online = false; this.#scheduleReconnect(); });
      this.#connection = connection;
      await connection.connect(registration);
      if (this.#closed) { connection.close(); return; }
      this.#online = true; this.#error = undefined;
    } catch { this.#online = false; this.#error = "IM_CONNECTION_FAILED"; this.#connection?.close(); this.#scheduleReconnect(); }
  }
  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnect) return;
    this.#reconnect = setTimeout(() => { this.#reconnect = undefined; void this.#connect(); }, 5_000);
    this.#reconnect.unref();
  }
  #receive(message: ImMessage): void {
    if (this.#closed || message.payload.type !== 1 || typeof message.payload.content !== "string") return;
    if (message.payload.space_id && message.payload.space_id !== this.config.spaceId) return;
    const allowed = this.config.allowedSenderIds ?? [this.#owner];
    if (!allowed.includes(message.fromUid) || message.channelType !== 1) return;
    const now = Date.now(); for (const [id, expiry] of this.#seen) if (expiry <= now) this.#seen.delete(id);
    if (this.#seen.has(message.messageId)) return;
    if (this.#seen.size >= 4096 || this.#pending >= 64 || Buffer.byteLength(message.payload.content) > 64 * 1024) throw new Error("IM_INBOUND_CAPACITY_EXHAUSTED");
    const key = `v1/octo/${encodeURIComponent(this.config.spaceId)}/${encodeURIComponent(this.config.botId)}/dm/${encodeURIComponent(message.channelId)}`;
    let session = this.#sessions.get(key);
    if (!session) {
      if (this.#sessions.size >= 128) throw new Error("IM_SESSION_CAPACITY_EXHAUSTED");
      session = { id: `as_${randomUUID()}`, generation: 1, pending: 0, tail: Promise.resolve() }; this.#sessions.set(key, session);
    }
    this.#seen.set(message.messageId, now + 120_000); session.pending++; this.#pending++;
    const active = session;
    session.tail = session.tail.then(() => this.#turn(message, key, active)).catch(() => { this.#error = "IM_TURN_FAILED"; }).finally(() => { active.pending--; this.#pending--; });
  }
  async #turn(message: ImMessage, sessionKey: string, session: Session): Promise<void> {
    if (this.#closed) return;
    const prompt = String(message.payload.content).trim();
    if (!prompt) return;
    const reply = async (text: string): Promise<void> => {
      if (this.#closed) return;
      await this.#connection!.sendText(message.channelId, message.channelType, text, `octo-${message.messageId}`, this.config.spaceId);
    };
    if (prompt === "/reset") {
      session.generation++; session.providerSession = undefined; session.lastRunId = undefined;
      await reply(`会话已重置。session=${session.id} generation=${session.generation}`); return;
    }
    if (prompt === "/session") { await reply(`session=${session.id} generation=${session.generation}${session.lastRunId ? ` run=${session.lastRunId}` : ""}`); return; }
    session.lastEventId = `evt_${randomUUID()}`; session.lastRunId = `run_${randomUUID()}`;
    const invocationId = `invoke_${randomUUID()}`;
    const compiled = compileRunContext(this.config.context);
    const request = {
      protocolVersion: 2 as const, invocationId, runId: session.lastRunId, agentSessionId: session.id,
      sessionGeneration: session.generation, providerEpoch: session.generation,
      agentSource: "provisioned" as const, prompt, modelInput: [compiled.modelContent, prompt].filter(Boolean).join("\n\n"), controlInstructions: compiled.controlInstructions ?? "", context: structuredClone(this.config.context),
      workdir: this.config.workdir, approvalMode: "full_access" as const,
      agentConfig: { workdir: this.config.workdir, ...(this.config.model ? { model: this.config.model } : {}) },
      ...(session.providerSession ? { providerSession: session.providerSession } : {}),
      runMetadata: { namespace: "im", spaceId: this.config.spaceId, eventId: session.lastEventId, sessionKey, actorId: message.fromUid,
        botId: this.config.botId, channelId: message.channelId, channelType: message.channelType, triggerOccurrenceId: message.messageId },
      runtimeLimits: { runTimeoutMs: 120_000 }, signal: this.#abort.signal
    };
    session.activeInvocationId = invocationId;
    let text = "", terminal = false, failed = false;
    try {
      assertInvokeRequest(request);
      for await (const event of this.dependencies.host.invoke(this.config.adapterType, request)) {
        if (event.type === "session.update") session.providerSession = event.payload.providerSession;
        if (event.type.startsWith("message.") && (event.payload.channel ?? "final") === "final" && typeof event.payload.text === "string") {
          text = event.type === "message.delta" ? text + event.payload.text : event.payload.text;
          if (Buffer.byteLength(text) > 256 * 1024) throw new Error("IM_RESULT_TOO_LARGE");
        }
        if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) { terminal = true; failed = event.type !== "run.completed"; }
      }
      if (!terminal) throw new Error("IM_RUN_WITHOUT_TERMINAL");
      await reply(failed ? "本轮执行未成功，请重试或发送 /reset。" : text || "本轮执行完成，未返回文本。");
    } catch {
      await this.dependencies.host.cancel(invocationId, "IM turn failed").catch(() => undefined);
      await reply("本轮执行失败，请重试或发送 /reset。");
    } finally { session.activeInvocationId = undefined; }
  }
  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort(); this.#online = false;
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#connection?.close();
    await Promise.allSettled([...this.#sessions.values()].filter(session => session.activeInvocationId).map(session => this.dependencies.host.cancel(session.activeInvocationId!, "IM shutdown")));
    await Promise.allSettled([...this.#sessions.values()].map(session => session.tail));
    this.#sessions.clear(); this.#seen.clear();
  }
}
