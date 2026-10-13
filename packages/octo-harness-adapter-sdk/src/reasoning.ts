/** Public Harness levels. Provider-specific names never enter the frozen request. */
export const OMNI_REASONING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"] as const);
export type OmniReasoningLevel = (typeof OMNI_REASONING_LEVELS)[number];
export type ReasoningLevelMap = Readonly<Record<OmniReasoningLevel, string>>;

const fourLevels: ReasoningLevelMap = Object.freeze({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh"
});
const threeLevels: ReasoningLevelMap = Object.freeze({
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high"
});

/**
 * Stable adapter defaults, not capability negotiation. OpenCode variants and
 * OpenClaw's advanced levels depend on their underlying model; use the common
 * three-level baseline. null means this transport has no implemented setter.
 */
export const DEFAULT_REASONING_LEVEL_MAPS: Readonly<Record<string, ReasoningLevelMap | null>> =
  Object.freeze({
    codex: fourLevels,
    "claude-code": fourLevels,
    antigravity: fourLevels,
    opencode: threeLevels,
    openclaw: threeLevels,
    codebuddy: null,
    hermes: null,
    "kimi-code": null,
    mcode: null,
    qodercli: null,
    qoderclicn: null,
    "zcode-gui": null
  });

export function reasoningLevelMap(adapterType: string): ReasoningLevelMap | null {
  return Object.hasOwn(DEFAULT_REASONING_LEVEL_MAPS, adapterType)
    ? DEFAULT_REASONING_LEVEL_MAPS[adapterType]
    : null;
}

export function mapReasoningEffort(
  adapterType: string,
  effort: string | undefined,
  levels = reasoningLevelMap(adapterType)
): string | undefined {
  if (effort === undefined) return undefined;
  if (!(OMNI_REASONING_LEVELS as readonly string[]).includes(effort)) {
    throw new TypeError("REASONING_LEVEL_INVALID: expected low, medium, high or xhigh");
  }
  return levels?.[effort as OmniReasoningLevel];
}
