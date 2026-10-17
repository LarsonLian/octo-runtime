import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  build_im_contexts,
  ImRuntime
} from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";
import { sendReadReceipt } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/messages.js";
import { interactionCard } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/interaction-card.js";
import {
  OctoConnector,
  stableEffectKey
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/connector.js";
import {
  fetchBotEvents,
  ackBotEvent
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/events.js";
import { parseCardAction } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/card-action.js";
import { interactionAnswer } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/interaction-card.js";
import { RuntimeLogging } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";
import { createCodexAdapter } from "../packages/octo-runtime-adapter-codex/dist/index.js";
import { ExtraPlugins } from "../packages/octo-runtime-daemon/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import Ws from "ws";
import {
  registerBot,
  WukongConnection
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";
import {
  deliveryNotice,
  deliveryNoticeCard
} from "../packages/octo-runtime-extra-channel-gateway/dist/presentation/delivery-notice.js";
import {
  getChannelMessages,
  fetchBotGroups
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";

// Octospec F01: 仅使用显式指定的测试账号；不输出凭据、正文或签名地址。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS);
const accounts = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .map((block) => {
    const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: value("Bot ID"), token: value("Bot Token"), api: value("API Server") };
  })
  .filter((account) => account.token?.startsWith("bf_"));
const [receiver, sender] = accounts;
assert.ok(receiver && sender);
for (const account of [receiver, sender]) {
  assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
  const identity = await verifyBotIdentity(account.api, account.token, AbortSignal.timeout(15000));
  assert.equal(identity.bot_uid, account.id);
}
const execute = promisify(execFile);
const groups = await Promise.all(
  [receiver, sender].map((account) =>
    fetchBotGroups({ apiUrl: account.api, botToken: account.token })
  )
);
const group = groups[0].find(
  (entry) =>
    entry.name.startsWith("Channel_QA_") &&
    groups[1].some((other) => other.group_no === entry.group_no)
);
assert.ok(group, "An existing isolated Channel_QA_ group shared by both test bots is required");
const marker = `F01_QA_${Date.now()}`;
if (process.argv.includes("--delivery")) {
  const originalEmit = Ws.prototype.emit,
    originalSend = Ws.prototype.send;
  let acks = [],
    sends = 0,
    dropping = false;
  Ws.prototype.emit = function (event, ...args) {
    if (dropping && event === "message" && Buffer.isBuffer(args[0]) && args[0][0] >> 4 === 4) {
      acks.push([this, args]);
      return true;
    }
    return originalEmit.call(this, event, ...args);
  };
  Ws.prototype.send = function (data, ...args) {
    if (dropping && Buffer.isBuffer(data) && data[0] >> 4 === 3) sends++;
    return originalSend.call(this, data, ...args);
  };
  const connection = new WukongConnection(() => {});
  try {
    await connection.connect(await registerBot(receiver.api, receiver.token));
    dropping = true;
    const lateKey = stableEffectKey(
      receiver.id,
      { channelId: group.group_no, channelType: 2 },
      marker,
      "late"
    );
    const late = connection.sendText(group.group_no, 2, `F27 late ACK QA ${marker}`, lateKey);
    await new Promise((resolve) => setTimeout(resolve, 15500));
    assert.ok(acks.length);
    const [socket, args] = acks.shift();
    originalEmit.call(socket, "message", ...args);
    await late;
    assert.equal(sends, 1);
    assert.equal(connection.isDelivered(lateKey), true);
    acks = [];
    sends = 0;
    const unknownKey = stableEffectKey(
      receiver.id,
      { channelId: group.group_no, channelType: 2 },
      marker,
      "unknown"
    );
    const unknown = await connection
      .sendText(group.group_no, 2, `F27 unknown ACK QA ${marker}`, unknownKey)
      .catch((error) => error);
    assert.equal(unknown.state, "unknown");
    assert.equal(sends, 4);
    dropping = false;
    const connector = new OctoConnector(
      { bot_id: receiver.id, api_url: receiver.api },
      receiver.token,
      AbortSignal.timeout(15000),
      async () => {}
    );
    const id = await connector.displayCard(
      { channelId: group.group_no, channelType: 2 },
      deliveryNoticeCard(deliveryNotice()),
      stableEffectKey(receiver.id, { channelId: group.group_no, channelType: 2 }, marker, "notice")
    );
    assert.ok(id);
    const messages = await getChannelMessages({
      apiUrl: receiver.api,
      botToken: receiver.token,
      channelId: group.group_no,
      channelType: 2,
      limit: 100
    });
    const notice = messages.find((message) => String(message.message_id) === id);
    assert.match(JSON.stringify(notice?.payload), /OH-RUN-2005/);
    const copies = messages.filter(
      (message) => message.payload?.content === `F27 unknown ACK QA ${marker}`
    ).length;
    console.log(
      JSON.stringify({
        feature: "F27",
        lateAckStoppedRetry: true,
        attempts: sends,
        unknownNoticeReadBack: true,
        serverVisibleCopies: copies
      })
    );
  } finally {
    dropping = false;
    Ws.prototype.emit = originalEmit;
    Ws.prototype.send = originalSend;
    await connection.close();
  }
  process.exit(0);
}
if (process.argv.includes("--interaction")) {
  const connector = new OctoConnector(
    { bot_id: receiver.id, api_url: receiver.api },
    receiver.token,
    AbortSignal.timeout(15000),
    async () => {}
  );
  const address = { channelId: group.group_no, channelType: 2 };
  const request = {
    interactionId: marker,
    executionInstanceId: "qa",
    kind: "question",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    request: {
      questions: [
        { id: "choice", question: "F09 协议验证", options: [{ label: "A" }, { label: "B" }] }
      ]
    }
  };
  const effect = stableEffectKey(receiver.id, address, marker, "interaction");
  const id = await connector.interactionCard(address, interactionCard(request), effect);
  assert.ok(id, "Test bot must have interaction card permission");
  if (process.argv.includes("--human-callback")) {
    const pages = await fetch(
      `${process.env.OCTO_QA_CDP_URL ?? "http://localhost:9222"}/json/list`
    ).then((response) => response.json());
    const page = pages.find((entry) => entry.title === "Octo Work");
    assert.ok(page, "Logged-in im-test Work App is required for the human callback");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("CDP_CALLBACK_TIMEOUT")), 15000);
        ws.addEventListener("message", (event) => {
          const result = JSON.parse(event.data);
          if (result.id !== 1) return;
          clearTimeout(timer);
          if (
            result.error ||
            result.result?.exceptionDetails ||
            result.result?.result?.value !== true
          ) {
            const description = result.result?.exceptionDetails?.exception?.description ?? "";
            reject(
              Error(
                description.includes("TEST_ONLY") ? "CDP_APP_NOT_IM_TEST" : "CDP_CALLBACK_FAILED"
              )
            );
          } else resolve();
        });
        ws.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              awaitPromise: true,
              returnByValue: true,
              expression: `(async()=>{const c=await window.octoWork.getConfig();if(c.serverUrl!=="https://im-test.deepminer.com.cn")throw Error("TEST_ONLY");const r=await window.octoWork.submitImCardAction(${JSON.stringify({ messageId: id, ...address, actionId: "interaction_answered", inputs: { custom0: "QA custom answer" } })});return r.accepted;})()`
            }
          })
        );
      });
    } finally {
      ws.close();
    }
    const events = await fetchBotEvents({
      apiUrl: receiver.api,
      botToken: receiver.token,
      limit: 100
    });
    const event = events.find(
      (event) => event.event_type === "card_action" && event.event_data?.message_id === id
    );
    assert.ok(event, "Real human callback must reach the bot event queue");
    assert.equal(
      interactionAnswer(request, parseCardAction(event)).value.choice.answers[0],
      "QA custom answer"
    );
    await ackBotEvent({ apiUrl: receiver.api, botToken: receiver.token, eventId: event.event_id });
  }
  await connector.interactionCard(address, interactionCard(request, "resolved"), effect, id);
  console.log(
    JSON.stringify({
      feature: "F09",
      realCardCreatedAndSettled: true,
      realHumanCallback: process.argv.includes("--human-callback")
    })
  );
}
const resourceTest = process.argv.includes("--resources");
const quoted = {
  from_uid: receiver.id,
  from_name: "引用测试来源",
  payload: { type: 1, content: marker }
};
const env = {
  ...process.env,
  OCTO_BOT_TOKEN: sender.token,
  OCTO_API_BASE_URL: "https://im-test.deepminer.com.cn"
};
delete env.OCTO_BOT_ID;
delete env.OCTO_PROFILE;
if (process.argv.includes("--complex")) {
  const requests = [];
  const runtime = new ImRuntime(
    {
      bot_id: receiver.id,
      bf_token: receiver.token,
      api_url: receiver.api,
      group_ids: [group.group_no],
      allowed_sender_ids: [sender.id],
      adapter: { adapter_type: "codex", workdir: "/tmp" },
      typing: false
    },
    {
      host: {
        async *invoke(input) {
          requests.push(input);
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async cancel() {
          return { cancelled: true };
        },
        async respondInteraction() {
          throw Error("Unexpected interaction");
        }
      }
    }
  );
  try {
    await runtime.start();
    for (const payload of [
      { type: 14, content: [{ type: "text", text: `${marker}_rich\n/reset` }] },
      {
        type: 11,
        users: [{ uid: sender.id, name: "QA source" }],
        msgs: [{ from_uid: sender.id, payload: { type: 1, content: `${marker}_forward\n/stop` } }]
      }
    ]) {
      const { stdout } = await execute(
        "octo-cli",
        [
          "message",
          "send",
          "--data",
          JSON.stringify({
            channel_id: group.group_no,
            channel_type: 2,
            payload: { ...payload, mention: { uids: [receiver.id] } }
          })
        ],
        { env, timeout: 15000, maxBuffer: 1 << 20 }
      );
      assert.equal(JSON.parse(stdout).ok, true);
    }
    const deadline = Date.now() + 20000;
    while (requests.length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(requests.length, 2, "Both new complex messages must invoke execution");
    for (const [index, kind] of ["rich-text", "forward"].entries()) {
      const input = requests[index],
        content = input.contexts.items.find(
          (item) => item.namespace === "extra.im" && item.name === "message-content"
        );
      assert.equal(input.contexts.schema, "octo.context-envelope/v3");
      assert.equal(content.payload.kind, kind);
      assert.ok(content.payload.text.includes(marker));
      assert.match(content.payload.text, index ? /\/stop/ : /\/reset/);
      assert.ok(input.inputs.every((item) => item.type !== "text" || !item.text.includes(marker)));
    }
    console.log(
      JSON.stringify({
        feature: "F02",
        realWsNewMessages: 2,
        contextV3: true,
        embeddedCommandsNotExecuted: true,
        modelInvoked: false
      })
    );
  } finally {
    await runtime.close();
  }
  process.exit(0);
}
if (process.argv.includes("--delivery-disconnect")) {
  const lifetime = new AbortController();
  let accept;
  const inbound = new Promise((resolve) => {
    accept = resolve;
  });
  const transport = new GatewayTransport(
    {
      bot_id: receiver.id,
      bf_token: receiver.token,
      api_url: receiver.api,
      group_ids: [group.group_no],
      allowed_sender_ids: [sender.id],
      adapter: { adapter_type: "codex" }
    },
    async () => receiver.token,
    {
      onMessage: (message) => {
        if (message.text === marker) accept(message);
      },
      onDisconnect: () => {}
    }
  );
  try {
    await transport.start(lifetime.signal);
    await execute(
      "octo-cli",
      [
        "message",
        "send",
        "--data",
        JSON.stringify({
          channel_id: group.group_no,
          channel_type: 2,
          payload: { type: 1, content: marker, mention: { uids: [receiver.id] } }
        })
      ],
      { env, timeout: 15000, maxBuffer: 1 << 20 }
    );
    let timer;
    const message = await Promise.race([
      inbound,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("QA_INBOUND_TIMEOUT")), 15000);
      })
    ]).finally(() => clearTimeout(timer));
    await transport.close();
    const before = new Set(
      (
        await getChannelMessages({
          apiUrl: receiver.api,
          botToken: receiver.token,
          channelId: group.group_no,
          channelType: 2,
          limit: 50
        })
      ).map((message) => String(message.message_id))
    );
    await message.replyDeliveryUnknown(
      deliveryNotice(),
      `${marker}:notice`,
      `${marker}:text`,
      lifetime.signal
    );
    const after = await getChannelMessages({
      apiUrl: receiver.api,
      botToken: receiver.token,
      channelId: group.group_no,
      channelType: 2,
      limit: 50
    });
    assert.ok(
      after.some(
        (message) =>
          !before.has(String(message.message_id)) &&
          JSON.stringify(message.payload).includes("OH-RUN-2005")
      )
    );
    console.log(
      JSON.stringify({ feature: "F27", wsClosed: true, restUnknownNoticeReadBack: true })
    );
  } finally {
    lifetime.abort();
    await transport.close();
  }
  process.exit(0);
}
if (
  process.argv.includes("--logging") ||
  process.argv.includes("--lifecycle") ||
  process.argv.includes("--dynamic-contexts")
) {
  const lifecycle = process.argv.includes("--lifecycle");
  const dynamic = process.argv.includes("--dynamic-contexts");
  let contextLoads = 0,
    providerCalls = 0,
    answer = "";
  const instruction = {
    namespace: "octo.control",
    name: "instructions",
    payload: { entries: [{ text: "我是明略科技的Octo助理" }] }
  };
  let toolStarted;
  const tool = new Promise((resolve) => {
    toolStarted = resolve;
  });
  const root = await mkdtemp(join(tmpdir(), "octo-f31-live-"));
  const logging = new RuntimeLogging({ directory: join(root, "logs") });
  const host = new AdapterHost({ log: logging.kernel });
  const adapter = createCodexAdapter();
  const invoke = adapter.invoke.bind(adapter);
  host.register({
    ...adapter,
    invoke: async function* (request, context) {
      if (dynamic) {
        providerCalls++;
        assert.equal(
          request.controlInstructions,
          "我是明略科技的Octo助理\n只回复 OCTO_CONTEXT_DYNAMIC_OK，不调用工具。"
        );
      }
      yield* invoke(request, context);
    }
  });
  const registrations = [
    {
      name: "channel-gateway",
      load: () => import("../packages/octo-runtime-extra-channel-gateway/dist/extra.js"),
      config: {
        bots: [
          {
            bot_id: receiver.id,
            bf_token: receiver.token,
            api_url: receiver.api,
            group_ids: [group.group_no],
            allowed_sender_ids: [sender.id],
            adapter: { adapter_type: "codex", workdir: root },
            approval_mode: "full_access",
            run_timeout_ms: 90000,
            ...(dynamic
              ? { context: { schema: "octo.context-envelope/v3", items: [instruction] } }
              : {})
          }
        ]
      }
    }
  ];
  const plugins = new ExtraPlugins(
    registrations,
    {
      async *invoke(...args) {
        for await (const event of host.invoke(...args)) {
          if (event.type === "tool_call.create") toolStarted();
          if (event.type === "message.delta" && event.payload.channel === "final")
            answer += event.payload.text ?? "";
          yield event;
        }
      },
      cancel: async (id, reason) => ({ cancelled: host.cancel(id, reason) }),
      respondInteraction: (id, response) => host.respondInteraction(id, response)
    },
    (name) => logging.extra(name)
  );
  try {
    if (dynamic) {
      const module = await import("../packages/octo-runtime-extra-channel-gateway/dist/extra.js");
      await plugins.load(module, registrations[0].config, {
        loadContexts: async (_config, { signal }) => {
          signal.throwIfAborted();
          contextLoads++;
          return [
            {
              ...instruction,
              payload: {
                entries: [
                  ...instruction.payload.entries,
                  { text: "只回复 OCTO_CONTEXT_DYNAMIC_OK，不调用工具。" }
                ]
              }
            }
          ];
        }
      });
    } else await plugins.loadConfigured();
    const status = await plugins.inspect("channel-gateway");
    assert.equal(status.bots[0].connected, true);
    const send = async (content) => {
      const result = await execute(
        "octo-cli",
        [
          "message",
          "send",
          "--data",
          JSON.stringify({
            channel_id: group.group_no,
            channel_type: 2,
            payload: {
              type: 1,
              content,
              mention: { uids: [receiver.id] }
            }
          })
        ],
        { env, timeout: 15000, maxBuffer: 1 << 20 }
      );
      assert.equal(JSON.parse(result.stdout).ok, true);
    };
    if (lifecycle) {
      await send(
        "请调用一次 shell 工具执行 sleep 20，不操作文件和网络；工具结束后只回复 F21_QA_DONE。"
      );
      let timer;
      try {
        await Promise.race([
          tool,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("Real provider did not start a tool")), 90000);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
      await plugins.unload("channel-gateway");
      await plugins.load("channel-gateway");
      assert.equal((await plugins.inspect("channel-gateway")).bots[0].connected, true);
    }
    await send("请不要调用工具，只回复 F31_LOG_QA_OK。");
    let finished = false;
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const files = await readdir(join(root, "logs")).catch(() => []);
      const text = (
        await Promise.all(
          files
            .filter((file) => file.endsWith(".log"))
            .map((file) => readFile(join(root, "logs", file), "utf8"))
        )
      ).join("");
      if (
        text
          .split("\n")
          .filter(Boolean)
          .some((line) => {
            const record = JSON.parse(line);
            return record.event === "invoke.finished" && record.data.status === "completed";
          })
      ) {
        finished = true;
        break;
      }
    }
    assert.equal(finished, true, "Real provider must finish before the test deadline");
    if (dynamic) {
      assert.equal(contextLoads, 1);
      assert.equal(providerCalls, 1);
      assert.match(answer, /OCTO_CONTEXT_DYNAMIC_OK/);
    }
    await plugins.close();
    await host.shutdown();
    await logging.close();
    const kernel = (
      await Promise.all(
        (await readdir(join(root, "logs")))
          .filter((file) => file.endsWith(".log"))
          .map((file) => readFile(join(root, "logs", file), "utf8"))
      )
    ).join("");
    const extras = (
      await Promise.all(
        (await readdir(join(root, "logs", "extras")))
          .filter((file) => file.endsWith(".log"))
          .map((file) => readFile(join(root, "logs", "extras", file), "utf8"))
      )
    ).join("");
    const final = kernel
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast((row) => row.event === "invoke.finished");
    assert.equal(final.data.status, "completed");
    assert.match(extras, /agent_run.requested/);
    assert.match(extras, /agent_run.finished/);
    assert.doesNotMatch(kernel + extras, /F31_LOG_QA_OK|bf_|请不要调用工具/);
    console.log(
      JSON.stringify({
        feature: dynamic ? "dynamic-contexts" : lifecycle ? "F21" : "F31",
        ...(dynamic ? { contextLoads, providerCalls, textOnlyInstructions: true } : {}),
        ...(lifecycle ? { toolStarted: true, sharedHostReload: true } : {}),
        imTestInbound: true,
        realProvider: "codex",
        terminal: final.data.status,
        kernelAndExtraLogs: true,
        noBodies: true
      })
    );
  } finally {
    await plugins.close();
    await host.shutdown();
    await logging.close();
    await rm(root, { recursive: true, force: true });
  }
  process.exit(0);
}
if (process.argv.includes("--capacity")) {
  let release,
    calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const runtime = new ImRuntime(
    {
      bot_id: receiver.id,
      bf_token: receiver.token,
      api_url: receiver.api,
      group_ids: [group.group_no],
      allowed_sender_ids: [sender.id],
      typing: false,
      adapter: { adapter_type: "codex", workdir: "/tmp" }
    },
    {
      host: {
        async *invoke() {
          calls++;
          await gate;
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async cancel() {
          release();
          return { cancelled: true };
        },
        async respondInteraction() {}
      }
    }
  );
  try {
    await runtime.start();
    assert.equal(runtime.status.state, "online");
    for (let index = 0; index < 6; index++) {
      try {
        await execute(
          "octo-cli",
          [
            "message",
            "send",
            "--data",
            JSON.stringify({
              channel_id: group.group_no,
              channel_type: 2,
              payload: {
                type: 1,
                content: `${marker}_capacity_${index}`,
                mention: { uids: [receiver.id] }
              }
            })
          ],
          { env, timeout: 15000, maxBuffer: 1 << 20 }
        );
      } catch {
        throw Error("IM_CAPACITY_TEST_SEND_FAILED");
      }
    }
    let busy, busyCard;
    for (let attempt = 0; attempt < 30 && (!busy || !busyCard); attempt++) {
      const messages = await getChannelMessages({
        apiUrl: receiver.api,
        botToken: receiver.token,
        channelId: group.group_no,
        channelType: 2,
        limit: 50,
        pullMode: 0
      });
      busy = messages.find(
        (message) => message.from_uid === receiver.id && message.content.includes("OH-RUN-2004")
      );
      busyCard = messages.find(
        (message) =>
          message.from_uid === receiver.id &&
          message.type === 17 &&
          JSON.stringify(message.payload).includes("OH-RUN-2004")
      );
      if (!busy || !busyCard) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(busy, "Session queue rejection must send a real busy text");
    assert.ok(busyCard, "Session queue rejection must send a separate error card");
    assert.equal(calls, 1);
    assert.equal(runtime.status.workingTasks, 1);
    assert.equal(runtime.status.queuedTasks, 4);
    console.log(
      JSON.stringify({
        feature: "F26",
        liveWs: true,
        working: 1,
        waiting: 4,
        sixthRejectedWithCardAndText: true
      })
    );
  } finally {
    release();
    await runtime.close();
  }
  process.exit(0);
}
let payload = { type: 1, content: marker, reply: quoted };
if (resourceTest) {
  const directory = await mkdtemp(join(tmpdir(), "octo-resource-qa-"));
  try {
    const file = join(directory, `${marker}.txt`);
    await writeFile(file, marker);
    let upload;
    try {
      const { stdout } = await execute("octo-cli", ["file", "upload", "--file", file], {
        env,
        timeout: 30000,
        maxBuffer: 1 << 20
      });
      upload = JSON.parse(stdout).data;
    } catch {
      throw Error("IM_TEST_UPLOAD_FAILED");
    }
    const address = upload?.url ?? upload?.path;
    assert.equal(typeof address, "string", "Uploaded file must have a real address");
    payload = { type: 8, content: marker, name: `${marker}.txt`, url: address };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
try {
  const { stdout } = await execute(
    "octo-cli",
    [
      "message",
      "send",
      "--data",
      JSON.stringify({
        channel_id: group.group_no,
        channel_type: 2,
        payload
      })
    ],
    { env, timeout: 30000, maxBuffer: 1 << 20 }
  );
  assert.equal(JSON.parse(stdout).ok, true);
} catch (error) {
  let code = "CLI_FAILED";
  try {
    code = JSON.parse(error.stderr || error.stdout).error.code;
  } catch {}
  throw new Error(
    `IM_TEST_SEND_FAILED:${String(code)
      .replace(/[^A-Z0-9_]/gi, "")
      .slice(0, 80)}`
  );
}
let received;
for (let attempt = 0; attempt < 10 && !received; attempt++) {
  const messages = await getChannelMessages({
    apiUrl: receiver.api,
    botToken: receiver.token,
    channelId: group.group_no,
    channelType: 2,
    limit: 30,
    pullMode: 0
  });
  received = messages.find((message) => message.content === marker);
  if (!received) await new Promise((resolve) => setTimeout(resolve, 300));
}
assert.ok(received, "Test message must be visible through the receiver identity");
if (process.argv.includes("--read")) {
  await sendReadReceipt({
    apiUrl: receiver.api,
    botToken: receiver.token,
    channelId: group.group_no,
    channelType: 2,
    messageIds: [received.message_id],
    signal: AbortSignal.timeout(15000)
  });
  console.log(JSON.stringify({ feature: "F05", readReceiptAccepted: true }));
}
if (!resourceTest) assert.deepEqual(received.payload.reply, quoted);
const envelope = await build_im_contexts(
  {
    bot_id: receiver.id,
    api_url: receiver.api,
    spaceId: "qa",
    adapter: { adapter_type: "codex", workdir: "/tmp" }
  },
  {
    messageId: received.message_id,
    messageSeq: received.message_seq,
    fromUid: sender.id,
    channelId: group.group_no,
    channelType: 2,
    timestamp: received.timestamp,
    payload: received.payload
  },
  receiver.token,
  AbortSignal.timeout(15000)
);
assert.ok(
  envelope.some(
    (item) =>
      item.namespace === "extra.im" &&
      item.name === (resourceTest ? "resources" : "reply") &&
      item.payload.text.includes(marker)
  )
);
assert.ok(
  envelope.some(
    (item) =>
      item.name === "group-rules" && ["present", "empty", "not_found"].includes(item.payload.status)
  )
);
if (process.argv.includes("--rules"))
  console.log(JSON.stringify({ feature: "F18", groupRulesLoadedWithoutSwitch: true }));
console.log(
  JSON.stringify({
    endpoint: receiver.api,
    feature: resourceTest ? "F04" : "F01",
    serverPreservesPayload: true,
    contextProjected: true
  })
);
