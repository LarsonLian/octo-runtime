/** 投递诊断投影为独立消息，不向原执行流追加虚假失败终态。 */
import { failurePayload, type CanonicalEvent } from "@mininglamp-oss/octo-runtime-protocol";

export function deliveryNotice(): CanonicalEvent<"message.create"> {
  const { failure, message } = failurePayload(
    { code: "IM_DELIVERY_UNKNOWN" },
    {
      stage: "channel_delivery",
      defaultDomain: "runtime",
      source: { component: "octo-runtime" }
    }
  );
  return {
    protocolVersion: 2,
    type: "message.create",
    payload: { role: "system", status: "delivery_unknown", text: String(message), failure }
  };
}

/** F27：.octospec/tasks/gateway-august-feature-assessment/assessment.md */
export function deliveryNoticeCard(event: CanonicalEvent): Record<string, unknown> {
  const { failure, text } = event.payload;
  if (
    event.type !== "message.create" ||
    event.payload.status !== "delivery_unknown" ||
    failure?.stage !== "channel_delivery"
  )
    throw Error("IM_DELIVERY_NOTICE_INVALID");
  return {
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: "回复送达结果未知", weight: "Bolder", wrap: true },
      { type: "TextBlock", text, wrap: true },
      {
        type: "TextBlock",
        text: `错误码：${failure.code}\n诊断编号：${failure.diagnosticId}`,
        wrap: true
      }
    ]
  };
}
