/**
 * 模板协商：只选择服务端明确声明可用且视图/动作合同完整的推理模板。
 * 服务端启用卡片不等于任意模板都能使用，能力不足时交给上层降级处理。
 */
import type { CardProfileManifest } from "./api/cards.js";
import type { ReasoningTemplate } from "./reasoning-frame.js";

export function selectReasoningTemplate(
  profile: CardProfileManifest
): ReasoningTemplate | undefined {
  const config = profile.config;
  if (
    !profile.available ||
    !profile.enabled ||
    profile.card_version !== "1.5" ||
    !profile.profiles?.includes("octo/v1") ||
    !profile.profiles.includes("octo/v2") ||
    !config?.card_enabled ||
    !config.reasoning_enabled ||
    !config.reasoning_template_ref ||
    !profile.templating?.supported ||
    profile.templating.wire !== "template-ref/v1"
  )
    return;
  const ref = config.reasoning_template_ref;
  const templates = profile.templating.templates.filter(
    (t) =>
      t.id === ref.id &&
      t.version === ref.version &&
      t.id === "ai.reasoning-process" &&
      t.available !== false
  );
  if (templates.length !== 1) return;
  for (const [name, wire, states, actions] of [
    ["active", "octo/v2", ["reasoning", "answering"], ["reasoning_stop"]],
    ["error", "octo/v2", ["error"], ["reasoning_retry"]],
    ["result", "octo/v1", ["completed", "stopped"], []]
  ] as const) {
    const views = templates[0].views.filter((view) => view.name === name);
    const view = views[0];
    if (
      views.length !== 1 ||
      !view ||
      view.wire_profile !== wire ||
      !states.every((s) => view.states.includes(s)) ||
      view.submit_actions.some((a) => !(actions as readonly string[]).includes(a))
    )
      return;
  }
  const limit = profile.limits?.max_payload_bytes;
  return {
    ref,
    maxPayloadBytes:
      typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : 16_384
  };
}
