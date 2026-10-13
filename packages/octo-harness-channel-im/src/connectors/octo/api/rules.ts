/**
 * 规则 API：读取 GROUP.md、话题规则及群级 @ 偏好，保留服务端版本与权限结果。
 * 规则正文是 Context 材料，不在此转为执行指令；触发偏好与正文材料各自处理。
 */
// Adapted from Mininglamp-OSS/openclaw-channel-octo/src/api-fetch.ts.
import { DEFAULT_TIMEOUT_MS } from "./client.js";
import { OctoApiError } from "./errors.js";

export interface RuleDocument {
  content: string;
  version: number;
  updated_at: string | null;
  updated_by: string;
}

// Short timeout for the per-message mention_pref hot-path lookup. On a cache
// miss this fires on the first message of every group every TTL window; before
// the backend ships it 404s, and we must not stall the inbound pipeline for the
// full 30s. A failed/slow lookup just falls back to the account-level config.
const MENTION_PREF_TIMEOUT_MS = 3_000;

/**
 * 群级免@偏好（per-group mention preference）。
 *
 * 后端 octo-server#237 暴露 GET /v1/bot/groups/:group_no/mention_pref。
 * 两个权限轴 AND 合成（octo-server YUJ-2996）：
 *  - `no_mention`：bot 主人意愿（bot_mention_pref，无记录=false）
 *  - `group_allow_no_mention`：群主/管理员的群级总开关（group.allow_no_mention，
 *    无群记录回退默认 true=允许）
 *  - `effective = no_mention && group_allow_no_mention`：最终是否免@即可触发。
 *
 * gate 只看 `effective`。`no_mention` / `group_allow_no_mention` 保留供观测/日志，
 * 并为旧 server（仅返回 no_mention）提供回退。
 */
export interface MentionPref {
  /** bot 主人意愿轴。旧 server 只有这个字段。 */
  no_mention: boolean;
  /** 群级总开关轴；无群记录回退 true（允许）。 */
  group_allow_no_mention: boolean;
  /** 两轴 AND：免@即可触发回复。gate 据此决策。 */
  effective: boolean;
}

/**
 * 获取某群对当前 bot 的免@偏好。
 *
 * 失败（网络错误 / 非 2xx / 解析失败）一律回退到账号级行为
 * （effective=false，即保持需@），绝不抛错，避免 gate 崩溃。
 *
 * 兼容旧 server：YUJ-2996 之前的 server 只返回 `{ no_mention }`，没有
 * `effective` / `group_allow_no_mention`。此时 group 轴缺省视为 true（允许），
 * effective 回退为 no_mention，行为与升级前完全一致（零回归）。
 */
export async function getMentionPref(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string; // 父群 group_no（thread 复合 channel_id 须先取父群）
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<MentionPref> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/mention_pref`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.botToken}`
      },
      signal: AbortSignal.timeout(MENTION_PREF_TIMEOUT_MS)
    });
    if (!resp.ok) {
      // 404 = the mention_pref endpoint isn't deployed yet (expected during
      // rollout before octo-server#237 ships); 401 = empty/short-lived Bearer.
      // Both are benign — we fall back to effective=false below — and recur on
      // every inbound message, so logging them at error level (compounded by
      // the 30s negative-cache TTL) makes a healthy rollout look broken. Log
      // expected statuses at info and reserve error for genuinely unexpected
      // responses (5xx, etc.).
      const expected = resp.status === 404 || resp.status === 401;
      const msg = `octo: getMentionPref(${params.groupNo}) failed: ${resp.status}`;
      if (expected) params.log?.info?.(msg);
      else params.log?.error?.(msg);
      return { no_mention: false, group_allow_no_mention: true, effective: false };
    }
    const data = (await resp.json()) as Record<string, unknown>;
    // Accept boolean `true` or numeric `1` (DB/JSON may serialize either),
    // mirroring the mention.{all,ais,humans} coercion in inbound.ts.
    const noMention = data?.no_mention === true || data?.no_mention === 1;
    // Old server omits group_allow_no_mention → default true (allow), so the
    // group axis is a no-op and effective degrades to noMention (zero regression).
    const groupAllow =
      data?.group_allow_no_mention === undefined
        ? true
        : data.group_allow_no_mention === true || data.group_allow_no_mention === 1;
    // Old server omits effective → fall back to the AND of the two axes (which,
    // with groupAllow defaulting true, equals noMention).
    const effective =
      data?.effective === undefined
        ? noMention && groupAllow
        : data.effective === true || data.effective === 1;
    return { no_mention: noMention, group_allow_no_mention: groupAllow, effective };
  } catch (err) {
    params.log?.error?.(
      `octo: getMentionPref(${params.groupNo}) error: ${err instanceof Error ? err.name : "unknown"}`
    );
    return { no_mention: false, group_allow_no_mention: true, effective: false };
  }
}

// Fetch GROUP.md content for a group
export async function getGroupMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ content: string; version: number; updated_at: string | null; updated_by: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/md`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${params.botToken}`
    },
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
      : AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw OctoApiError.from(resp, "getGroupMd", text);
  }
  return (await resp.json()) as RuleDocument;
}

/**
 * Get thread THREAD.md content (throws on non-2xx — used by agent-tools).
 * GET /v1/bot/groups/{groupNo}/threads/{shortId}/md
 *
 * See also: group-md.ts `fetchThreadMdFromApi()` which returns null on error
 * and is used for background cache refresh where failures are non-fatal.
 */
export async function getThreadMd(params: {
  apiUrl: string;
  botToken: string;
  groupNo: string;
  shortId: string;
  signal?: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void };
}): Promise<{ content: string; version: number; updated_at: string | null; updated_by: string }> {
  const url = `${params.apiUrl.replace(/\/+$/, "")}/v1/bot/groups/${encodeURIComponent(params.groupNo)}/threads/${encodeURIComponent(params.shortId)}/md`;
  const resp = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${params.botToken}` },
    signal: params.signal
      ? AbortSignal.any([params.signal, AbortSignal.timeout(DEFAULT_TIMEOUT_MS)])
      : AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw OctoApiError.from(resp, "getThreadMd", text);
  }
  return (await resp.json()) as RuleDocument;
}
