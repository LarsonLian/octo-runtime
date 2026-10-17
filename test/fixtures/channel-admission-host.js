import { serveAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { testAdapter } from "./test-adapter.js";

// .octospec/tasks/channel-group-admission/plan.md：真实 IM/IPC 使用确定性执行端，
// 只记录本轮测试标记，不调用模型、不记录 Context 或执行环境中的 Bot 凭据。
serveAdapterHost([
  {
    ...testAdapter,
    async *invoke(request) {
      const marker = request.prompt.match(/GROUP_ADMISSION_QA_[a-z0-9_]+/g)?.at(-1);
      if (!marker) throw new Error("QA_MARKER_REQUIRED");
      await appendFile(
        join(request.workdir, "admission-trace.jsonl"),
        `${JSON.stringify({ marker })}\n`
      );
      yield {
        protocolVersion: 2,
        type: "session.update",
        payload: { providerSession: { sessionId: `test:${request.agentSessionId}` } }
      };
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: { channel: "final", text: `GROUP_ADMISSION_REPLY:${marker}` }
      };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  }
]);
