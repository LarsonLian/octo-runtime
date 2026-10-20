// 运行时回归：用加密 WS 验证入站授权、会话排队、即时取消与交互回传。
// 此测试证明协议与编排行为，不能代替真实 IM 客户端验收。
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  diffieHellman
} from "node:crypto";
import { WebSocketServer } from "ws";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { validateImBots } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { waitFor } from "./runtime-fixture.js";
import { prepareInvokeInput } from "@mininglamp-oss/octo-runtime-executor-core";
import { imCardProfile } from "./fixtures/im-card-profile.js";
const md5 = (s) => createHash("md5").update(s).digest("hex");
const str = (s) => {
  const b = Buffer.from(s),
    h = Buffer.alloc(2);
  h.writeUInt16BE(b.length);
  return Buffer.concat([h, b]);
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const pack = (header, body) => {
  let n = body.length;
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 128;
    bytes.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([header, ...bytes]), body]);
};
const unpack = (b) => {
  let i = 1;
  while (b[i++] & 128) {}
  return b.subarray(i);
};
function reader(b) {
  let p = 0;
  return {
    byte: () => b[p++],
    str: () => {
      const n = b.readUInt16BE(p);
      p += 2;
      const s = b.subarray(p, p + n).toString();
      p += n;
      return s;
    },
    u32: () => {
      const n = b.readUInt32BE(p);
      p += 4;
      return n;
    },
    rest: () => b.subarray(p)
  };
}

test("IM owns one binary WS, reuses session, resets provider handle, and replies only after Host terminal", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oh-im-"));
  let conn, key;
  const iv = Buffer.from("0123456789abcdef");
  const replies = [],
    payloads = [],
    calls = [];
  const cancellations = [],
    responses = [];
  let releaseInteraction, releaseCancellation;
  const cards = [],
    actions = [],
    acknowledged = [],
    polls = new Set();
  let eventNo = 0;
  let failFirstAck = true;
  const flushPolls = () => {
    for (const poll of polls) {
      const batch = actions.filter((action) => action.event_id > poll.cursor);
      if (!batch.length) continue;
      poll.res.end(JSON.stringify({ results: batch }));
      polls.delete(poll);
    }
  };
  const crypt = (text, decrypt = false) => {
    const cipher = decrypt
      ? createDecipheriv("aes-128-cbc", key, iv)
      : createCipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([
      cipher.update(decrypt ? Buffer.from(text, "base64") : Buffer.from(text)),
      cipher.final()
    ]).toString(decrypt ? "utf8" : "base64");
  };
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/auth/verify-bot") {
      res.end(JSON.stringify({ bot_uid: "bot", space_id: "space" }));
      return;
    }
    assert.equal(req.headers.authorization, "Bearer bf_fixture");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/v1/bot/register") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          robot_id: "bot",
          owner_uid: "owner",
          owner_channel_id: "owner",
          im_token: "secret",
          ws_url: `ws://127.0.0.1:${server.address().port}`
        })
      );
    } else if (req.url === "/v1/bot/user/info?uid=owner")
      res.end(JSON.stringify({ uid: "owner", name: "李白", robot: 0 }));
    else if (req.url === "/v1/bot/card/profile") res.end(JSON.stringify(imCardProfile()));
    else if (req.url === "/v1/bot/sendMessage") {
      const body = JSON.parse(Buffer.concat(chunks));
      const messageId = String(2000 + cards.length);
      cards.push({ messageId, frame: body.payload.data, interaction: body.payload.card });
      res.end(JSON.stringify({ message_id: messageId }));
    } else if (req.url === "/v1/bot/events") {
      const body = JSON.parse(Buffer.concat(chunks));
      const poll = { res, cursor: body.event_id };
      polls.add(poll);
      const timer = setTimeout(() => {
        polls.delete(poll);
        res.end('{"results":[]}');
      }, 1500);
      res.once("close", () => {
        clearTimeout(timer);
        polls.delete(poll);
      });
      flushPolls();
    } else if (/^\/v1\/bot\/events\/\d+\/ack$/.test(req.url)) {
      if (failFirstAck) {
        failFirstAck = false;
        res.statusCode = 500;
        res.end("{}");
        return;
      }
      acknowledged.push(Number(req.url.split("/").at(-2)));
      res.end("{}");
    } else res.end("{}");
  });
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket) => {
    conn = socket;
    socket.on("message", (data) => {
      const header = data[0],
        kind = header >> 4,
        r = reader(unpack(data));
      if (kind === 1) {
        assert.equal(r.byte(), 4);
        r.byte();
        r.str();
        assert.equal(r.str(), "bot");
        assert.equal(r.str(), "secret");
        const remaining = r.rest();
        const cr = reader(remaining.subarray(8));
        const publicBytes = Buffer.from(cr.str(), "base64");
        const pair = generateKeyPairSync("x25519");
        const pub = createPublicKey({
          format: "der",
          type: "spki",
          key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), publicBytes])
        });
        key = Buffer.from(
          md5(
            diffieHellman({ privateKey: pair.privateKey, publicKey: pub }).toString("base64")
          ).slice(0, 16)
        );
        socket.send(
          pack(
            0x21,
            Buffer.concat([
              Buffer.from([4]),
              u64(0),
              Buffer.from([1]),
              str(
                pair.publicKey
                  .export({ format: "der", type: "spki" })
                  .subarray(-32)
                  .toString("base64")
              ),
              str(iv.toString()),
              u64(1)
            ])
          )
        );
      }
      if (kind === 3) {
        assert.equal(header & 2, 2, "normal messages must update conversation unread state");
        r.byte();
        const seq = r.u32(),
          clientNo = r.str(),
          channel = r.str(),
          type = r.byte();
        r.u32();
        const hash = r.str(),
          payload = r.rest().toString();
        assert.equal(hash, md5(crypt(`${seq}${clientNo}${channel}${type}${payload}`)));
        const value = JSON.parse(crypt(payload, true));
        assert.equal(value.space_id, "space");
        payloads.push(value);
        replies.push(value.content);
        socket.send(
          pack(0x40, Buffer.concat([u64(100 + seq), u32(seq), u32(seq), Buffer.from([1])]))
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "bf_fixture", { mode: 0o600 });
  const host = {
    list: async () => [],
    probe: async () => ({}),
    cancel: async (invocationId) => {
      cancellations.push(invocationId);
      releaseCancellation?.();
      releaseInteraction?.();
      return { cancelled: true };
    },
    respondInteraction: async (invocationId, response) => {
      responses.push({ invocationId, response });
      releaseInteraction?.();
    },
    async *invoke(input, environment) {
      assert.deepEqual(environment.executionEnvOverrides?.env_variables, [
        { key: "OCTO_BOT_TOKEN", value: "bf_fixture" },
        { key: "OCTO_API_BASE_URL", value: `http://127.0.0.1:${server.address().port}` }
      ]);
      const { adapterType: adapter, request } = prepareInvokeInput(input);
      request.signal = environment?.signal;
      assert.equal(adapter, "codex");
      assert.equal(request.approvalMode, "ask");
      assert.equal(request.runMetadata.actorId, "owner");
      calls.push(request);
      if (request.prompt === "approval") {
        const gate = new Promise((resolve) => (releaseInteraction = resolve));
        yield {
          protocolVersion: 2,
          type: "interaction.requested",
          payload: {
            interactionId: "interaction-fixture",
            executionInstanceId: "instance",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            kind: "approval",
            request: { operation: { summary: "Approve fixture" } }
          }
        };
        await gate;
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
        return;
      }
      if (request.prompt === "wait" || request.prompt === "card-wait") {
        await new Promise((resolve) => (releaseCancellation = resolve));
        yield { protocolVersion: 2, type: "run.cancelled", payload: {} };
        return;
      }
      if (request.prompt === "retry-card") {
        if (calls.filter((call) => call.prompt === "retry-card").length === 1)
          yield { protocolVersion: 2, type: "run.failed", payload: {} };
        else yield { protocolVersion: 2, type: "run.completed", payload: {} };
        return;
      }
      yield {
        protocolVersion: 2,
        type: "session.update",
        payload: { providerSession: { sessionId: "provider-session" } }
      };
      yield {
        protocolVersion: 2,
        type: "message.delta",
        payload: { messageId: "answer", channel: "final", text: "完整" }
      };
      yield {
        protocolVersion: 2,
        type: "message.update",
        payload: { messageId: "answer", channel: "final", text: "完整答复 @[owner:李白]" }
      };
      assert.equal(replies.length, calls.length === 1 ? 0 : 3);
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  };
  const runtime = new ImRuntime(
    {
      enabled: true,
      allowed_sender_ids: ["owner", "other"],
      api_url: `http://127.0.0.1:${server.address().port}`,
      bot_id: "bot",
      bf_token: "bf_fixture",
      approval_mode: "ask",
      adapter: { adapter_type: "codex", workdir: dir },
      context: { schema: "octo.context-envelope/v3", items: [] }
    },
    { host }
  );
  t.after(async () => {
    await runtime.close();
    ws.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  await runtime.start();
  assert.equal(runtime.status.connected, true);
  let seq = 0;
  const send = (content, sender = "owner", channel = "bot") => {
    const n = ++seq,
      id = BigInt(1000 + n),
      stamp = 12345,
      clientNo = `incoming-${n}`,
      payload = crypt(JSON.stringify({ type: 1, content, space_id: "space" }));
    const hash = md5(crypt(`${id}${n}${clientNo}${stamp}${sender}${channel}1${payload}`));
    conn.send(
      pack(
        0x52,
        Buffer.concat([
          Buffer.from([0]),
          str(hash),
          str(sender),
          str(channel),
          Buffer.from([1]),
          u32(0),
          str(clientNo),
          u64(id),
          u32(n),
          u32(stamp),
          Buffer.from(payload)
        ])
      )
    );
  };
  send("hello");
  await waitFor(() => replies.length === 1);
  assert.equal(replies[0], "完整答复 @李白");
  assert.deepEqual(payloads[0].mention, {
    uids: ["owner"],
    entities: [{ uid: "owner", offset: 5, length: 3 }]
  });
  const session = calls[0].agentSessionId;
  send("/session");
  await waitFor(() => replies.length === 2);
  assert.match(replies[1], new RegExp(session));
  send("/reset");
  await waitFor(() => replies.length === 3);
  assert.equal(replies[2], "会话已经重置");
  assert.equal(payloads[1].mention, undefined);
  assert.equal(payloads[2].mention, undefined);
  send("after reset");
  await waitFor(() => replies.length === 4);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].providerSession, undefined);
  assert.notEqual(calls[1].agentSessionId, session);
  assert.equal(calls[1].sessionGeneration, 2);
  send("approval");
  await waitFor(() =>
    cards.some((card) =>
      card.interaction?.actions?.some((action) => action.id === "interaction_accepted")
    )
  );
  send("/approve interaction-fixture", "stranger");
  send("/approve interaction-fixture", "other");
  await waitFor(() => replies.some((reply) => reply.includes("不属于当前会话")));
  assert.equal(responses.length, 0);
  send("/approve interaction-fixture");
  await waitFor(() => responses.length === 1 && runtime.status.sessions.length === 0);
  assert.equal(responses[0].invocationId, calls[2].invocationId);
  assert.equal(responses[0].response.outcome, "accepted");
  send("wait");
  await waitFor(() => !!releaseCancellation);
  const beforeReset = replies.length;
  send("/reset");
  await waitFor(() => replies.length > beforeReset && replies.at(-1) === "会话已经重置");
  assert.equal(cancellations.length, 0, "reset does not cancel the active run");
  assert.equal(runtime.status.sessions[0].sessionId, undefined);
  send("/stop");
  await waitFor(
    () => cancellations.length === 1 && replies.some((reply) => reply.includes("本轮执行已中断"))
  );
  assert.equal(cancellations[0], calls[3].invocationId);
  assert.equal(calls.length, 4, "control messages must not invoke another model run");
  const push = (eventType, data) => {
    const id = ++eventNo;
    actions.push({ event_id: id, event_type: eventType, event_data: data });
    flushPolls();
    return id;
  };
  send("card-wait");
  await waitFor(
    () => calls.length === 5 && cards.some((card) => card.frame?.reasoningId === calls[4].runId)
  );
  const current = cards.find((card) => card.frame?.reasoningId === calls[4].runId);
  const callback = {
    message_id: current.messageId,
    channel_id: "owner",
    channel_type: 1,
    operator_uid: "owner",
    space_id: "space",
    action_id: "reasoning_stop"
  };
  const unknown = push("doc_comment_mention", {});
  const forged = push("card_action", {
    ...callback,
    operator_uid: "stranger",
    inputs: { operator_uid: "owner" }
  });
  const stopped = push("card_action", callback);
  await waitFor(() => cancellations.length === 2 && acknowledged.includes(stopped), 5000);
  assert.equal(cancellations[1], calls[4].invocationId);
  assert.ok(!acknowledged.includes(unknown));
  assert.ok(!acknowledged.includes(forged));
  send("retry-card");
  await waitFor(
    () => calls.length === 6 && cards.some((card) => card.frame?.reasoningId === calls[5].runId)
  );
  const failed = cards.find((card) => card.frame?.reasoningId === calls[5].runId);
  const retry = push("card_action", {
    ...callback,
    message_id: failed.messageId,
    action_id: "reasoning_retry"
  });
  await waitFor(() => calls.length === 7 && acknowledged.includes(retry), 5000);
  assert.notEqual(calls[6].runId, calls[5].runId);
  assert.equal(calls[6].runMetadata.triggerOccurrenceId, `card_action:${retry}`);
  assert.equal(calls[6].prompt, "retry-card");
});

test("duplicate bot identities fail before opening connections", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "oh-im-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bot = {
    api_url: "https://im.example/api",
    bot_id: "bot",
    bf_token: "bf_fixture",
    adapter: { adapter_type: "codex", workdir: dir },
    context: { schema: "octo.context-envelope/v3", items: [] }
  };
  assert.throws(() => validateImBots([bot, { ...bot }]), /IM_BOT_DUPLICATED/);
});
