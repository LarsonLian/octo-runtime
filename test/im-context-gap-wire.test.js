import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync
} from "node:crypto";
import { WebSocketServer } from "ws";
import { WukongConnection } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";
import { setImmediate as settle } from "node:timers/promises";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { CardSession } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/card-session.js";

const hash = (value) => createHash("md5").update(value).digest("hex");
function integer(value, bytes = 4) {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 8) buffer.writeBigUInt64BE(BigInt(value));
  else buffer.writeUInt32BE(value);
  return buffer;
}
function string(value) {
  const body = Buffer.from(value);
  const size = Buffer.alloc(2);
  size.writeUInt16BE(body.length);
  return Buffer.concat([size, body]);
}
function packet(kind, body, flags = 0) {
  let remaining = body.length;
  const size = [];
  do {
    const digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    size.push(digit | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.concat([Buffer.from([(kind << 4) | flags, ...size]), body]);
}
function reader(data) {
  let offset = 1;
  while (data[offset++] & 128) {}
  return {
    byte: () => data[offset++],
    skip: (count) => {
      offset += count;
    },
    uint: () => {
      const value = data.readUInt32BE(offset);
      offset += 4;
      return value;
    },
    text: () => {
      const length = data.readUInt16BE(offset);
      offset += 2;
      const value = data.subarray(offset, offset + length).toString();
      offset += length;
      return value;
    }
  };
}

test("gateway observation keeps scope gates, separates execution admission and binds ACK/card positions to their original turn", async (context) => {
  let wire;
  const admitted = [];
  const observed = [];
  const sends = [];
  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (url.endsWith("/auth/verify-bot"))
      return Response.json({ bot_uid: "bot", space_id: "space" });
    if (url.endsWith("/bot/register"))
      return Response.json({
        robot_id: "bot",
        owner_uid: "owner",
        owner_channel_id: "owner",
        ws_url: "wss://im-test.deepminer.com.cn/ws",
        im_token: "fixture"
      });
    if (url.endsWith("/bot/events"))
      return new Promise((resolve) => {
        const done = () => resolve(Response.json({ results: [] }));
        if (options.signal.aborted) done();
        else options.signal.addEventListener("abort", done, { once: true });
      });
    throw Error("unexpected fixture request");
  });
  context.mock.method(WukongConnection.prototype, "connect", async function () {
    wire = this;
  });
  context.mock.method(WukongConnection.prototype, "close", async () => {});
  context.mock.getter(WukongConnection.prototype, "connected", () => true);
  context.mock.method(WukongConnection.prototype, "sendText", async (...args) => {
    sends.push(args);
    return "output";
  });
  context.mock.getter(CardSession.prototype, "messageId", () => "known-card");
  const transport = new GatewayTransport(
    {
      bot_id: "bot",
      api_url: "https://im-test.deepminer.com.cn/api",
      group_ids: ["group"],
      typing: false,
      adapter: { adapter_type: "codex" }
    },
    async () => "bf_fixture",
    {
      onMessage: (message) => admitted.push(message),
      onPosition: (position) => observed.push(position),
      onDisconnect() {}
    }
  );
  context.after(() => transport.close());
  await transport.start(new AbortController().signal);
  const position = {
    channelId: "group____topic",
    channelType: 5,
    fromUid: "stranger",
    messageSeq: 101,
    messageId: "101",
    clientMsgNo: "peer",
    spaceId: "space"
  };
  for (const override of [
    {},
    { channelId: "other____topic" },
    { spaceId: "other" },
    { channelType: 1 }
  ])
    wire.onPosition({ ...position, ...override });
  assert.equal(observed.length, 1);
  wire.onMessage({ ...position, payload: { type: 1, content: "/reset" } });
  assert.equal(admitted.length, 0);
  wire.onMessage({
    ...position,
    fromUid: "owner",
    payload: { type: 1, content: "summary", mention: { uids: ["bot"] } }
  });
  assert.equal(admitted.length, 1);
  const original = { sessionId: "old-session", generation: 1, processEpoch: "epoch" };
  admitted[0].bindHistoryTurn(original);
  await admitted[0].reply("output", "effect");
  admitted[0].beginPresentation("run", () => {}, {
    async cancel() {
      return false;
    },
    retry() {
      return false;
    }
  });
  admitted[0].bindHistoryTurn({ ...original, sessionId: "new-session", generation: 2 });
  sends[0][7](102);
  assert.deepEqual(observed.at(-1).turn, original);
  wire.onPosition({ ...position, fromUid: "bot", messageId: "known-card", messageSeq: 103 });
  assert.deepEqual(observed.at(-1).turn, original);
});

test("wire positions distinguish SENDACK client/message sequences, observe own RECV without executing it, and ignore failed ACKs", async (context) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  let socket;
  let key;
  const iv = Buffer.from("0123456789abcdef");
  const encrypt = (value) => {
    const cipher = createCipheriv("aes-128-cbc", key, iv);
    return Buffer.concat([cipher.update(value), cipher.final()]).toString("base64");
  };
  server.on("connection", (connection) => {
    socket = connection;
    connection.on("message", (data) => {
      const incoming = reader(data);
      const kind = data[0] >> 4;
      if (kind === 1) {
        incoming.skip(2);
        incoming.text();
        incoming.text();
        incoming.text();
        incoming.skip(8);
        const publicBytes = Buffer.from(incoming.text(), "base64");
        const pair = generateKeyPairSync("x25519");
        const publicKey = createPublicKey({
          format: "der",
          type: "spki",
          key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), publicBytes])
        });
        key = Buffer.from(
          hash(diffieHellman({ privateKey: pair.privateKey, publicKey }).toString("base64")).slice(
            0,
            16
          )
        );
        connection.send(
          packet(
            2,
            Buffer.concat([
              Buffer.from([4]),
              integer(0, 8),
              Buffer.from([1]),
              string(
                pair.publicKey
                  .export({ format: "der", type: "spki" })
                  .subarray(-32)
                  .toString("base64")
              ),
              string(iv.toString()),
              integer(1, 8)
            ]),
            1
          )
        );
      } else if (kind === 3) {
        incoming.byte();
        const clientSequence = incoming.uint();
        const clientNo = incoming.text();
        const reason = clientNo === "rejected" ? 2 : 1;
        connection.send(
          packet(
            4,
            Buffer.concat([
              integer(900 + clientSequence, 8),
              integer(clientSequence),
              integer(700 + clientSequence),
              Buffer.from([reason])
            ])
          )
        );
      }
    });
  });
  const messages = [];
  const positions = [];
  const acknowledgements = [];
  const connection = new WukongConnection(
    (message) => messages.push(message),
    () => {},
    (position) => positions.push(position)
  );
  context.after(async () => {
    await connection.close();
    await new Promise((resolve) => server.close(resolve));
  });
  await connection.connect({
    robot_id: "bot",
    im_token: "fixture",
    owner_uid: "owner",
    owner_channel_id: "owner",
    ws_url: `ws://127.0.0.1:${server.address().port}`
  });
  assert.equal(
    await connection.sendText(
      "group____topic",
      5,
      "fixture",
      "accepted",
      "space",
      undefined,
      undefined,
      (sequence) => acknowledgements.push(sequence)
    ),
    "901"
  );
  assert.deepEqual(acknowledgements, [701]);
  await assert.rejects(
    connection.sendText(
      "group____topic",
      5,
      "fixture",
      "rejected",
      "space",
      undefined,
      undefined,
      (sequence) => acknowledgements.push(sequence)
    )
  );
  assert.deepEqual(acknowledgements, [701]);
  for (const [fromUid, sequence] of [
    ["bot", 702],
    ["peer", 703]
  ]) {
    const clientNo = `fixture-${sequence}`;
    const timestamp = 1;
    const messageId = 1000 + sequence;
    const encrypted = encrypt(
      JSON.stringify({ type: 1, content: "unmentioned", space_id: "space" })
    );
    const signature = hash(
      encrypt(`${messageId}${sequence}${clientNo}${timestamp}${fromUid}group____topic5${encrypted}`)
    );
    socket.send(
      packet(
        5,
        Buffer.concat([
          Buffer.from([0]),
          string(signature),
          string(fromUid),
          string("group____topic"),
          Buffer.from([5]),
          integer(0),
          string(clientNo),
          integer(messageId, 8),
          integer(sequence),
          integer(timestamp),
          Buffer.from(encrypted)
        ])
      )
    );
  }
  for (let attempt = 0; positions.length < 2 && attempt < 1000; attempt++) await settle();
  assert.deepEqual(
    positions.map((position) => position.messageSeq),
    [702, 703]
  );
  assert.deepEqual(
    messages.map((message) => message.fromUid),
    ["peer"]
  );
  assert.equal(
    positions.some((position) => Object.hasOwn(position, "payload")),
    false
  );
});
