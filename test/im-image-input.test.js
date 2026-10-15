import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate as settle } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  imagePart,
  imageUrl,
  downloadImageInput
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/image-input.js";
import { acceptsImMessage } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jq1sAAAAASUVORK5CYII=",
  "base64"
);
const config = {
  bot_id: "images",
  api_url: "https://im-test.deepminer.com.cn/api",
  adapter: { adapter_type: "codex", workdir: process.cwd() },
  spaceId: "space",
  group_ids: ["g"]
};

test("standalone images use the same explicit UID/AI broadcast gate and reject all other media", () => {
  const message = {
    messageId: "m",
    fromUid: "owner",
    channelId: "g",
    channelType: 2,
    payload: { type: 2, url: "image.png" }
  };
  assert.equal(acceptsImMessage(config, "owner", message), false);
  for (const mention of [{ uids: ["images"] }, { ais: 1 }]) {
    message.payload.mention = mention;
    assert.equal(acceptsImMessage(config, "owner", message), true);
  }
  for (const type of ["2", 3, 11, 14]) {
    message.payload.type = type;
    assert.equal(acceptsImMessage(config, "owner", message), false);
  }
});

test("image bytes retain MIME, canonical base64, size and digest; invalid or truncated files fail", () => {
  const part = imagePart(png, "image/png");
  assert.equal(part.byteSize, png.length);
  assert.equal(part.data, png.toString("base64"));
  assert.equal(part.sha256, createHash("sha256").update(png).digest("hex"));
  assert.equal(part.mimeType, "image/png");
  assert.throws(() => imagePart(png, "image/jpeg"), /不一致/);
  assert.throws(() => imagePart(png.subarray(0, 40)), /损坏/);
  assert.throws(() => imagePart(Buffer.from("GIF89a")), /不支持/);
  assert.equal(imageUrl("file/preview/a.png", config.api_url).href, `${config.api_url}/file/a.png`);
});

test("downloads enforce streamed size limits, redirect validation, cancellation and same-origin credentials", async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    assert.equal(req.headers.authorization, "Bearer bf_fixture");
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/image" });
      res.end();
    } else if (req.url === "/external") {
      res.writeHead(302, { Location: "https://127.0.0.1/private" });
      res.end();
    } else if (req.url === "/large") {
      res.writeHead(200);
      res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
    } else if (req.url === "/loop") {
      res.writeHead(302, { Location: "/loop" });
      res.end();
    } else if (req.url === "/hang") {
      res.writeHead(200);
      res.write(png.subarray(0, 8));
    } else {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const api = `http://127.0.0.1:${server.address().port}/api`;
  const read = (path, signal = AbortSignal.timeout(2000)) =>
    downloadImageInput(path, api, "bf_fixture", signal);
  assert.equal((await read("/redirect"))[0].data, png.toString("base64"));
  await assert.rejects(read("/large"), /2 MiB/);
  await assert.rejects(read("/external"), /地址不可访问/);
  await assert.rejects(read("/loop"), /重定向/);
  for (const path of [
    "file:///tmp/a",
    "https://user:pass@example.org/a",
    "http://169.254.169.254/x"
  ]) {
    const before = requests;
    await assert.rejects(read(path));
    assert.equal(requests, before);
  }
  await assert.rejects(read("/hang", AbortSignal.timeout(30)));
});

test("image-only IM reaches Codex as image inputs; unsupported engine does not download or invoke", async (t) => {
  let receive;
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = (m) => this.callbacks.onMessage(m);
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  for (const adapter of ["codex", "claude-code", "openclaw"]) {
    const calls = [],
      replies = [];
    let downloads = 0;
    const runtime = new ImRuntime(
      {
        ...config,
        adapter: {
          adapter_type: adapter,
          ...(adapter === "openclaw" ? {} : { workdir: process.cwd() })
        }
      },
      {
        host: {
          async *invoke(input) {
            calls.push(input);
            yield { protocolVersion: 2, type: "run.completed", payload: {} };
          },
          async cancel() {
            return { cancelled: false };
          },
          async respondInteraction() {}
        }
      }
    );
    await runtime.start();
    receive({
      messageId: adapter,
      senderId: "owner",
      conversationId: "chat",
      conversationKind: "direct",
      text: "",
      async buildInputs() {
        downloads++;
        return [imagePart(png)];
      },
      async buildContext() {
        return { schema: "octo.context-envelope/v3", items: [] };
      },
      async reply(text) {
        replies.push(text);
      }
    });
    for (let i = 0; i < 40 && runtime.status.sessions.length; i++) await settle();
    assert.equal(calls.length, adapter === "codex" ? 1 : 0);
    assert.equal(downloads, calls.length);
    if (calls.length) {
      assert.deepEqual(calls[0].inputs, [imagePart(png)]);
      assert.equal(calls[0].modelInput, "[Image]");
    } else assert.match(replies[0], /仅 Codex/);
    await runtime.close();
  }
});
