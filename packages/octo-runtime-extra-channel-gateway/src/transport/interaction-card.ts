import type {
  InteractionRequestedPayload,
  InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type { CardAction } from "./card-action.js";

// Octospec F09: .octospec/tasks/gateway-august-feature-assessment/assessment.md
// 只投影 CanonicalEvent，禁止解析模型正文、Provider 原始帧或自定义工具调用。
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const block = (value: string) => ({ type: "TextBlock", text: value, wrap: true });
export function interactionCard(
  request: InteractionRequestedPayload,
  settled?: string
): Record<string, unknown> {
  if (settled)
    return { type: "AdaptiveCard", version: "1.5", body: [block(`交互已结束：${settled}`)] };
  const body: Record<string, unknown>[] = [
    block(request.kind === "approval" ? "执行需要确认" : "执行需要你的回答")
  ];
  const fields = request.request;
  if (request.kind === "question" && Array.isArray(fields.questions)) {
    const ids = new Set<string>();
    for (const [index, raw] of fields.questions.entries()) {
      const question = record(raw),
        id = text(question.id);
      if (!id || ids.has(id) || question.isSecret === true)
        throw Error("IM_INTERACTION_FORM_UNSUPPORTED");
      ids.add(id);
      body.push(block(text(question.question) || text(question.header)));
      const choices = (Array.isArray(question.options) ? question.options : [])
        .map((raw) => {
          const option = record(raw);
          return {
            title: [text(option.label), text(option.description)].filter(Boolean).join("："),
            value: text(option.label)
          };
        })
        .filter((option) => option.value);
      if (choices.length)
        body.push({ type: "Input.ChoiceSet", id: `q${index}`, choices, style: "compact" });
      body.push({
        type: "Input.Text",
        id: `custom${index}`,
        label: "自定义回答",
        maxLength: 4000,
        isMultiline: true
      });
    }
    if (!ids.size) throw Error("IM_INTERACTION_FORM_UNSUPPORTED");
  } else if (request.kind === "approval") {
    body.push(block(text(record(fields.operation).summary) || "确认本次操作"));
  } else {
    body.push(block(text(fields.question) || text(fields.message) || "请输入回答"));
    if (request.kind === "elicitation")
      body.push(block(JSON.stringify(fields.requestedSchema ?? {})));
    body.push({
      type: "Input.Text",
      id: "answer",
      label: request.kind === "elicitation" ? "JSON 回答" : "回答",
      maxLength: 8000,
      isMultiline: true
    });
  }
  const actions = (
    request.kind === "approval"
      ? [
          ["accepted", "允许"],
          ["declined", "拒绝"]
        ]
      : [["answered", "提交"]]
  ).concat([["cancelled", "取消"]]);
  return {
    type: "AdaptiveCard",
    version: "1.5",
    body,
    actions: actions.map(([outcome, title]) => ({
      type: "Action.Submit",
      id: `interaction_${outcome}`,
      title,
      data: { __octo: { card_seq: 1, action_id: `interaction_${outcome}` } }
    }))
  };
}

export function interactionAnswer(
  request: InteractionRequestedPayload,
  action: CardAction
): InteractionResponse {
  if (
    !Number.isFinite(Date.parse(request.expiresAt)) ||
    Date.parse(request.expiresAt) <= Date.now()
  )
    throw Error("IM_INTERACTION_EXPIRED");
  const outcome = action.actionId.slice("interaction_".length);
  const allowed =
    request.kind === "approval" ? ["accepted", "declined", "cancelled"] : ["answered", "cancelled"];
  if (!allowed.includes(outcome)) throw Error("IM_INTERACTION_OUTCOME_INVALID");
  const response: InteractionResponse = {
    interactionId: request.interactionId,
    outcome: outcome as InteractionResponse["outcome"]
  };
  if (outcome !== "answered") return response;
  if (request.kind === "question" && Array.isArray(request.request.questions)) {
    response.value = Object.fromEntries(
      request.request.questions.map((raw, index) => {
        const question = record(raw),
          custom = action.inputs[`custom${index}`]?.trim();
        const choice = action.inputs[`q${index}`];
        const options = (Array.isArray(question.options) ? question.options : []).map((option) =>
          text(record(option).label)
        );
        if (question.isSecret === true || (!custom && (!choice || !options.includes(choice))))
          throw Error("IM_INTERACTION_ANSWER_REQUIRED");
        const answer = custom || choice;
        if (Buffer.byteLength(answer) > 4096) throw Error("IM_INTERACTION_ANSWER_TOO_LARGE");
        return [text(question.id), { answers: [answer] }];
      })
    );
  } else {
    const answer = action.inputs.answer?.trim();
    if (!answer || Buffer.byteLength(answer) > 4096) throw Error("IM_INTERACTION_ANSWER_REQUIRED");
    response.value = request.kind === "elicitation" ? (JSON.parse(answer) as unknown) : answer;
  }
  return response;
}
