/**
 * Octo 出站适配：统一文本、typing 和模板卡片发送，以及服务端能力发现。
 * 持有当前连接的凭据与取消信号，为上层屏蔽 REST/WS 差异，不决定执行或业务流程。
 */
import { createHash } from "node:crypto";
import type { ImAddress, OctoBotConfig } from "../../contracts.js";
import { getCardProfile, sendTemplateCardMessage, editTemplateCardMessage } from "./api/cards.js";
import { sendMessage, sendTyping } from "./api/messages.js";
import { selectReasoningTemplate } from "./cards.js";
import type { ReasoningFrame, ReasoningTemplate } from "./reasoning-frame.js";

export class OctoConnector {
  #profile?: { expires: number; template?: ReasoningTemplate };
  constructor(
    readonly config: OctoBotConfig,
    readonly token: string,
    readonly signal: AbortSignal,
    readonly sendWsText: (address: ImAddress, text: string, effectKey: string) => Promise<void>
  ) {}
  async reasoningTemplate(): Promise<ReasoningTemplate | undefined> {
    if (this.config.cards === false) return;
    if (this.#profile && this.#profile.expires > Date.now()) return this.#profile.template;
    const profile = await getCardProfile({
      apiUrl: this.config.api_url,
      botToken: this.token,
      signal: this.requestSignal()
    });
    const template = selectReasoningTemplate(profile);
    this.#profile = { expires: Date.now() + 300_000, template };
    return template;
  }
  requestSignal(signal?: AbortSignal): AbortSignal {
    return AbortSignal.any([this.signal, AbortSignal.timeout(3_000), ...(signal ? [signal] : [])]);
  }
  async typing(address: ImAddress, signal: AbortSignal): Promise<void> {
    await sendTyping({
      apiUrl: this.config.api_url,
      botToken: this.token,
      ...address,
      signal: this.requestSignal(signal)
    });
  }
  async text(address: ImAddress, text: string, effectKey: string): Promise<void> {
    await this.sendWsText(address, text, effectKey);
  }
  async notification(address: ImAddress, text: string, effectKey: string): Promise<string> {
    const receipt = await sendMessage({
      apiUrl: this.config.api_url,
      botToken: this.token,
      ...address,
      content: text,
      clientMsgNo: effectKey,
      signal: this.requestSignal()
    });
    if (!receipt?.message_id) throw new Error("IM_DELIVERY_RECEIPT_UNKNOWN");
    return String(receipt.message_id);
  }
  async card(
    address: ImAddress,
    template: ReasoningTemplate,
    frame: ReasoningFrame,
    effectKey: string,
    messageId?: string,
    seq = 1,
    transient = true
  ): Promise<string> {
    const common = {
      apiUrl: this.config.api_url,
      botToken: this.token,
      ...address,
      templateRef: template.ref,
      state: frame.state,
      data: frame,
      signal: this.requestSignal(),
      retryOn429: false
    };
    if (messageId) {
      await editTemplateCardMessage({ ...common, messageId, cardSeq: seq, transient });
      return messageId;
    }
    const receipt = await sendTemplateCardMessage({ ...common, clientMsgNo: effectKey });
    if (!receipt?.message_id) throw new Error("IM_DELIVERY_RECEIPT_UNKNOWN");
    return String(receipt.message_id);
  }
}

export function stableEffectKey(
  endpointId: string,
  address: ImAddress,
  runId: string,
  kind: string
): string {
  const id = createHash("sha256")
    .update([endpointId, String(address.channelType), address.channelId, runId, kind].join("\0"))
    .digest("hex")
    .slice(0, 32);
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
