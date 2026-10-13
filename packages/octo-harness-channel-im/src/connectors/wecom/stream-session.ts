/**
 * 企业微信回复流：一次空 think 启动原生思考气泡，最终消息结束同一个 stream。
 * 同一请求的发送必须逐个等待 ACK，避免并发覆盖或终态被迟到的思考帧覆盖。
 */
import { randomUUID } from "node:crypto";
import type { ImPresentation } from "../../contracts.js";

/** 企业微信 IM 呈现：空 think stream 触发客户端原生思考气泡，不是独立 typing API。 */
export class WecomStreamSession {
  #streamId = `stream_${randomUUID()}`;
  #tail: Promise<void> = Promise.resolve();
  #sealed = true;
  #closed = false;
  constructor(readonly send: (streamId: string, text: string, finish: boolean) => Promise<void>) {}

  begin(onDiagnostic: (code: string) => void): ImPresentation {
    this.#streamId = `stream_${randomUUID()}`;
    this.#sealed = false;
    // 一次空 think 即可触发原生气泡；重复发送会与当前 stream 冲突。
    void this.#send("<think></think>", false).catch(() =>
      onDiagnostic("WECOM_TYPING_DELIVERY_FAILED")
    );
    return {
      update: () => undefined,
      // 等待已发送思考帧的 ACK 后，再由最终回复结束气泡。
      finish: async () => {
        this.#sealed = true;
        await this.#tail;
      }
    };
  }
  reply(text: string, effectKey?: string): Promise<void> {
    const finish = this.#sealed || effectKey?.startsWith("final:") === true;
    if (finish) this.#sealed = true;
    return this.#send(text, finish);
  }
  #send(text: string, finish: boolean): Promise<void> {
    const streamId = this.#streamId;
    // 共享 req_id 的交互和最终回复都串行等 ACK，防止服务端匹配到错误请求。
    const operation = this.#tail.then(() => {
      if (this.#closed) throw new Error("WECOM_STREAM_CLOSED");
      return this.send(streamId, text, finish);
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }
  close(): void {
    this.#closed = true;
    this.#sealed = true;
  }
}
