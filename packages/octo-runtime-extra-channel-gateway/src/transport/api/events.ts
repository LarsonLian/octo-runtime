/**
 * 事件 API：提供有界轮询和 ACK，用于取回卡片动作等服务端事件。
 * 只负责事件传输；消费范围、授权和动作归属由通道决定，不承接文档评论业务。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import type { BotEvent } from "./types.js";
import { postJson } from "./client.js";

// Card-event poll requests run in a single sequential loop; without a bound a hung
// /v1/bot/events (or its ack) would block all callback processing for the account until the OS
// eventually drops the socket.
//
// This bounds an *idle* request only. When the caller opts into the server-side long poll the
// server deliberately holds the connection open for up to `wait` seconds, so a fixed 10s cap
// would abort every hold longer than that and log a failure on each one — see
// eventsPollTimeoutMs, which derives the bound from the requested hold instead.
const EVENTS_POLL_TIMEOUT_MS = 10_000;

// Slack added on top of a long-poll hold before the client gives up. It has to cover the
// server rounding the final BLPOP chunk up to a whole second plus ordinary network/scheduling
// jitter; the client must never be the side that times out first, because an abort loses the
// batch the server was about to hand back.
const EVENTS_POLL_WAIT_MARGIN_MS = 10_000;

/**
 * Mirrors the server-side clamp on `wait`. Single source of truth — the JSON schemas and the
 * poller all derive from this, so the plugin and the server cannot drift apart silently.
 */
export const MAX_EVENT_WAIT_SECONDS = 30;

/**
 * Smallest useful hold. Below this the loop issues *more* requests than the short polling it
 * replaces (a 1s hold with no added delay is 60 req/min against a 29 req/min baseline), and the
 * "did the server actually hold?" guard shrinks to a window narrower than an ordinary slow RTT.
 * A non-zero value under this is raised to it rather than rejected.
 */
export const MIN_EVENT_WAIT_SECONDS = 5;

/**
 * Client timeout for one /v1/bot/events request.
 *
 * Must always exceed the hold the server was asked for, otherwise the client aborts mid-hold
 * and the poll loop degrades into a timeout/retry storm that is strictly worse than plain
 * short polling.
 */
export function eventsPollTimeoutMs(waitSeconds?: number): number {
  if (!waitSeconds || waitSeconds <= 0) return EVENTS_POLL_TIMEOUT_MS;
  return waitSeconds * 1000 + EVENTS_POLL_WAIT_MARGIN_MS;
}

/**
 * Pull typed bot events strictly after the supplied cursor.
 *
 * With `waitSeconds` unset or 0 this is a plain short poll: the server reads the queue once and
 * answers, empty batch included. With `waitSeconds > 0` the server holds an empty queue open for
 * that long and answers as soon as an event lands, which is what takes card-action latency off
 * the poll cadence. The hold is opt-in on the wire precisely so that a client which does not
 * raise its own timeout keeps working unchanged.
 *
 * An expired hold is a normal empty batch, not an error — there is no timeout status to handle.
 */
export async function fetchBotEvents(params: {
  apiUrl: string;
  botToken: string;
  sinceEventId?: number;
  limit?: number;
  waitSeconds?: number;
  signal?: AbortSignal;
}): Promise<BotEvent[]> {
  const waitSeconds =
    params.waitSeconds && params.waitSeconds > 0
      ? Math.min(MAX_EVENT_WAIT_SECONDS, Math.floor(params.waitSeconds))
      : 0;
  const response = await postJson<{ results?: BotEvent[] }>(
    params.apiUrl,
    params.botToken,
    "/v1/bot/events",
    {
      event_id: params.sinceEventId ?? 0,
      limit: Math.max(1, Math.min(100, Math.floor(params.limit ?? 20))),
      // Omitted entirely when not long-polling, so the request stays byte-identical to what
      // servers that predate the `wait` field already accept.
      ...(waitSeconds > 0 ? { wait: waitSeconds } : {})
    },
    params.signal ?? AbortSignal.timeout(eventsPollTimeoutMs(waitSeconds)),
    // The poll loop paces itself from the outcome of each request, with an exponential
    // backoff on errors. It also infers "did the server hold?" from the time elapsed
    // around this call, and a sleep inside it would inflate that measurement: a fast
    // empty return after a backoff reads as an honoured hold and re-polls immediately.
    { retryOn429: false }
  );
  return Array.isArray(response?.results) ? response.results : [];
}

/** Best-effort queue pruning after a recognized bot event has been accepted locally. */
export async function ackBotEvent(params: {
  apiUrl: string;
  botToken: string;
  eventId: number;
  signal?: AbortSignal;
}): Promise<void> {
  await postJson(
    params.apiUrl,
    params.botToken,
    `/v1/bot/events/${params.eventId}/ack`,
    {},
    params.signal ?? AbortSignal.timeout(EVENTS_POLL_TIMEOUT_MS),
    // An ack runs inside the poll loop's sequential drain and its failure is only
    // logged — it never becomes a poll outcome, so nothing downstream would pace a
    // retry. Sleeping here would just stall the events queued behind this one, and the
    // callers normally persist the cursor before the ack, so a lost ack costs at
    // most one redelivery. During a deliberately blocked cursor gap, the poller
    // only ACKs recognized handlers that carry their own event-level idempotency.
    { retryOn429: false }
  );
}
