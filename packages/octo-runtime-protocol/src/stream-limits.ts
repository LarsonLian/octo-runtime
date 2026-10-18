export interface StreamLimitPolicy {
  rawMessageMaxBytes: number;
  adapterQueueItemMaxBytes: number;
  adapterQueueMaxBytes: number;
  adapterQueueMaxItems: number;
  hostFrameMaxBytes: number;
  rpcQueueMaxBytes: number;
  rpcQueueMaxItems: number;
  replayRunMaxBytes: number;
  replayRunMaxItems: number;
  replayGlobalMaxBytes: number;
}

export type StreamLimitOverrides = Partial<StreamLimitPolicy>;

const MIB = 1024 * 1024;

export const DEFAULT_STREAM_LIMIT_POLICY: Readonly<StreamLimitPolicy> = Object.freeze({
  rawMessageMaxBytes: 16 * MIB,
  adapterQueueItemMaxBytes: 20 * MIB,
  adapterQueueMaxBytes: 32 * MIB,
  adapterQueueMaxItems: 4096,
  hostFrameMaxBytes: 20 * MIB,
  rpcQueueMaxBytes: 32 * MIB,
  rpcQueueMaxItems: 4096,
  replayRunMaxBytes: 32 * MIB,
  replayRunMaxItems: 4096,
  replayGlobalMaxBytes: 128 * MIB
});

export const MAX_STREAM_LIMIT_POLICY: Readonly<StreamLimitPolicy> = Object.freeze(
  Object.fromEntries(
    Object.entries(DEFAULT_STREAM_LIMIT_POLICY).map(([key, value]) => [key, value * 2])
  ) as unknown as StreamLimitPolicy
);

export const HOST_RPC_MAX_LINE_BYTES = MAX_STREAM_LIMIT_POLICY.hostFrameMaxBytes + 64 * 1024;

export function resolveStreamLimitPolicy(
  overrides: StreamLimitOverrides | undefined
): Readonly<StreamLimitPolicy> {
  if (
    overrides !== undefined &&
    (overrides === null || typeof overrides !== "object" || Array.isArray(overrides))
  )
    throw new TypeError("stream_limits must be an object");
  const fields = new Set(Object.keys(DEFAULT_STREAM_LIMIT_POLICY));
  for (const key of Object.keys(overrides ?? {})) {
    if (!fields.has(key)) throw new TypeError(`unknown stream_limits.${key}`);
  }
  const policy = { ...DEFAULT_STREAM_LIMIT_POLICY, ...(overrides ?? {}) };
  for (const key of Object.keys(DEFAULT_STREAM_LIMIT_POLICY) as (keyof StreamLimitPolicy)[]) {
    const value = policy[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STREAM_LIMIT_POLICY[key]) {
      throw new TypeError(`invalid stream_limits.${key}`);
    }
  }
  if (policy.rawMessageMaxBytes > policy.adapterQueueItemMaxBytes)
    throw new TypeError("stream_limits.rawMessageMaxBytes exceeds adapterQueueItemMaxBytes");
  if (policy.adapterQueueItemMaxBytes > policy.adapterQueueMaxBytes)
    throw new TypeError("stream_limits.adapterQueueItemMaxBytes exceeds adapterQueueMaxBytes");
  if (policy.hostFrameMaxBytes > policy.rpcQueueMaxBytes)
    throw new TypeError("stream_limits.hostFrameMaxBytes exceeds rpcQueueMaxBytes");
  if (policy.hostFrameMaxBytes > policy.replayRunMaxBytes)
    throw new TypeError("stream_limits.hostFrameMaxBytes exceeds replayRunMaxBytes");
  if (policy.replayRunMaxBytes > policy.replayGlobalMaxBytes)
    throw new TypeError("stream_limits.replayRunMaxBytes exceeds replayGlobalMaxBytes");
  return Object.freeze(policy);
}

export const STREAM_CAPACITY_REASONS = [
  "PROVIDER_MESSAGE_TOO_LARGE",
  "HOST_FRAME_TOO_LARGE",
  "STREAM_QUEUE_ITEM_TOO_LARGE",
  "STREAM_QUEUE_BYTES_EXCEEDED",
  "STREAM_QUEUE_ITEMS_EXCEEDED"
] as const;

export type StreamCapacityReason = (typeof STREAM_CAPACITY_REASONS)[number];

export function isStreamCapacityReason(value: unknown): value is StreamCapacityReason {
  return (STREAM_CAPACITY_REASONS as readonly unknown[]).includes(value);
}

export function streamCapacityError(
  code: StreamCapacityReason,
  detail: {
    boundary: string;
    measuredBytes?: number;
    limitBytes?: number;
    itemCount?: number;
    limitItems?: number;
  }
): Error {
  return Object.assign(new Error(code), { code, ...detail });
}
