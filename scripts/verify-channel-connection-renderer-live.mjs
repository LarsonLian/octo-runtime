import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

// 代理只转发到 im-test；通过切断专用 Bot 的代理连接验证真实桌面后台和 renderer。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "Set OCTO_CHANNEL_QA_ACCOUNTS");
const blocks = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1);
const block = blocks[Number(process.env.OCTO_CONNECTION_RENDERER_QA_INDEX ?? 2)];
const field = (key) => block?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
const account = { id: field("Bot ID"), token: field("Bot Token"), api: field("API Server") };
assert.ok(account.token?.startsWith("bf_"));
assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
const observerBlock = blocks[3];
const observerField = (key) =>
  observerBlock?.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
const observerAccount = {
  id: observerField("Bot ID"),
  token: observerField("Bot Token"),
  api: observerField("API Server")
};
assert.ok(observerAccount.token?.startsWith("bf_"));
assert.equal(observerAccount.api, account.api);
assert.notEqual(observerAccount.id, account.id);
const screenshots = process.env.OCTO_CONNECTION_SCREENSHOTS ?? "/tmp/octo-connection-renderer";
await mkdir(screenshots, { recursive: true });
let blocked = false,
  upstreamUrl,
  authAttempts = 0;
const connections = new Set(),
  pending = new Map(),
  failures = [];
const proxy = createServer(async (req, res) => {
  try {
    if (!["/v1/auth/verify-bot", "/v1/bot/register"].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    if (req.url === "/v1/auth/verify-bot") {
      authAttempts++;
      if (blocked) {
        res.writeHead(503).end();
        return;
      }
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      assert.ok(bytes <= 65536);
      chunks.push(chunk);
    }
    const response = await fetch(`${account.api}${req.url}`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      body: Buffer.concat(chunks),
      headers: {
        "Content-Type": "application/json",
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {})
      }
    });
    const value = await response.json();
    if (req.url === "/v1/bot/register" && response.ok) {
      upstreamUrl = value.ws_url;
      assert.equal(new URL(upstreamUrl).protocol, "wss:");
      value.ws_url = `ws://127.0.0.1:${proxy.address().port}`;
    }
    res
      .writeHead(response.status, { "Content-Type": "application/json" })
      .end(JSON.stringify(value));
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});
const server = new WebSocketServer({ server: proxy });
server.on("connection", (client) => {
  const upstream = new WebSocket(upstreamUrl),
    queued = [];
  connections.add(client);
  upstream.on("open", () => {
    for (const data of queued) upstream.send(data);
    queued.length = 0;
  });
  client.on("message", (data) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
    else queued.push(data);
  });
  upstream.on("message", (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  });
  client.on("close", () => {
    connections.delete(client);
    upstream.terminate();
  });
  upstream.on("close", () => client.terminate());
  upstream.on("error", () => client.terminate());
  client.on("error", () => upstream.terminate());
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const pages = await fetch("http://127.0.0.1:9222/json/list").then((r) => r.json());
const page = pages.find((p) => p.type === "page" && p.url.includes("localhost:5173"));
assert.ok(page);
const cdp = new WebSocket(page.webSocketDebuggerUrl);
await once(cdp, "open");
let sequence = 0,
  id,
  observerId;
cdp.on("message", (bytes) => {
  const message = JSON.parse(bytes);
  if (message.method === "Runtime.exceptionThrown")
    failures.push(message.params.exceptionDetails.text);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error || message.result?.exceptionDetails)
    call.reject(Error("Renderer command failed"));
  else call.resolve(message.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(n);
      reject(Error("Renderer timeout"));
    }, 30000);
    pending.set(n, { resolve, reject, timer });
    cdp.send(JSON.stringify({ id: n, method, params }));
  });
}
const evaluate = async (expression) =>
  (await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    .result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw Error("Renderer state verification timed out");
}
const status = () =>
  evaluate(
    `window.octoWork.listImChannels().then(items=>{const b=items.find(x=>x.channelId===${JSON.stringify(id)});return b?{state:b.state,error:b.error}:null})`
  );
const assertObserverOnline = async () =>
  assert.equal(
    await evaluate(
      `window.octoWork.listImChannels().then(items=>items.find(x=>x.channelId===${JSON.stringify(observerId)})?.state)`
    ),
    "online"
  );
async function screen(state) {
  await evaluate(
    "window.dispatchEvent(new CustomEvent('octo-work:open-settings',{detail:'imChannels'}))"
  );
  let lastRow;
  try {
    await wait(async () => {
      const row = await evaluate(
        `(()=>{const r=document.querySelector('[data-channel-id="'+${JSON.stringify(id)}+'"]');return r?{online:r.querySelector('.im-channel-row__status')?.dataset.online,text:r.innerText}:null})()`
      );
      if (!row)
        await evaluate(
          "window.dispatchEvent(new CustomEvent('octo-work:open-settings',{detail:'imChannels'}))"
        );
      lastRow = row;
      return (
        row &&
        row.online === String(state === "online") &&
        (state === "online"
          ? !row.text.includes("IM_")
          : state === "failed"
            ? /失败|failed/i.test(row.text)
            : /重连|reconnect|retry/i.test(row.text))
      );
    });
  } catch (error) {
    console.error(JSON.stringify({ expected: state, row: lastRow, status: await status() }));
    throw error;
  }
  const result = await command("Page.captureScreenshot", { format: "png" });
  await writeFile(`${screenshots}/${state}.png`, Buffer.from(result.data, "base64"));
}
try {
  await command("Runtime.enable");
  await command("Page.enable");
  const environment = await evaluate(
    "Promise.all([window.octoWork.getConfig(),window.octoWork.getEmbeddedRuntimeStatus(),window.octoWork.listImChannels()]).then(([c,r,b])=>({server:c.serverUrl,pid:r.daemonPid,phase:r.phase,ids:b.map(x=>x.channelId),botIds:b.map(x=>x.connection.botId)}))"
  );
  assert.equal(environment.server, "https://im-test.deepminer.com.cn");
  assert.equal(environment.phase, "running");
  assert.ok(!environment.botIds.includes(account.id), "Use an idle dedicated QA Bot");
  assert.ok(!environment.botIds.includes(observerAccount.id), "Use an idle observer QA Bot");
  const input = {
    name: `连接状态验证 ${randomUUID().slice(0, 8)}`,
    platform: "octo",
    enabled: true,
    connection: {
      url: `http://127.0.0.1:${proxy.address().port}`,
      botId: account.id,
      spaceId: "",
      token: "bf_invalid_connection_verification",
      secret: ""
    },
    adapter: "codex",
    model: "",
    effort: "medium",
    instructions: ""
  };
  const save = async (value) =>
    evaluate(
      `window.octoWork.saveImChannel(${JSON.stringify(value)}).then(b=>({channelId:b.channelId,state:b.state,error:b.error}))`
    );
  const first = await save(input);
  id = first.channelId;
  assert.equal(first.state, "failed");
  assert.equal(first.error, "IM_AUTH_HTTP_401");
  await evaluate(
    "window.dispatchEvent(new CustomEvent('octo-work:open-settings',{detail:'imChannels'}))"
  );
  await screen("failed");
  const observer = await save({
    ...input,
    name: "连接隔离验证",
    connection: {
      ...input.connection,
      url: observerAccount.api,
      botId: observerAccount.id,
      token: observerAccount.token
    }
  });
  observerId = observer.channelId;
  assert.equal(observer.state, "online", observer.error);
  assert.equal((await status()).state, "failed");
  const valid = {
    ...input,
    channelId: id,
    connection: { ...input.connection, token: account.token }
  };
  const online = await save(valid);
  assert.equal(online.state, "online", online.error);
  await screen("online");
  const attempt = authAttempts,
    dropped = Date.now();
  blocked = true;
  for (const client of connections) client.terminate();
  await wait(async () => (await status())?.state === "retrying");
  await screen("retrying");
  await assertObserverOnline();
  await wait(() => authAttempts > attempt, 10000);
  const firstWait = Date.now() - dropped;
  assert.ok(firstWait >= 4500 && firstWait < 8000);
  blocked = false;
  await wait(async () => (await status())?.state === "online");
  assert.equal((await status()).error, undefined);
  await screen("online");
  await assertObserverOnline();
  const secondAttempt = authAttempts,
    secondDrop = Date.now();
  blocked = true;
  for (const client of connections) client.terminate();
  await wait(() => authAttempts > secondAttempt, 10000);
  const secondWait = Date.now() - secondDrop;
  assert.ok(secondWait >= 4500 && secondWait < 8000);
  await assertObserverOnline();
  await evaluate(`window.octoWork.deleteImChannel(${JSON.stringify(id)})`);
  id = undefined;
  const stoppedAttempts = authAttempts;
  await sleep(11000);
  assert.equal(authAttempts, stoppedAttempts);
  await assertObserverOnline();
  await evaluate(`window.octoWork.deleteImChannel(${JSON.stringify(observerId)})`);
  observerId = undefined;
  const after = await evaluate(
    "Promise.all([window.octoWork.listImChannels(),window.octoWork.getEmbeddedRuntimeStatus()]).then(([b,r])=>({ids:b.map(x=>x.channelId),pid:r.daemonPid}))"
  );
  assert.deepEqual(after.ids, environment.ids);
  assert.equal(after.pid, environment.pid);
  assert.equal(failures.length, 0);
  console.log(
    JSON.stringify({
      passed: true,
      endpoint: account.api,
      localProxyFaultInjection: true,
      initialFailureVisible: true,
      retryingVisible: true,
      recoveryVisible: true,
      multiBotIsolationSamplesPassed: true,
      firstWaitMs: firstWait,
      secondOutageWaitMs: secondWait,
      stopCancelsRecovery: true,
      daemonPid: after.pid,
      originalChannelsPreserved: true,
      rendererExceptions: failures.length,
      screenshots
    })
  );
} finally {
  if (id) await evaluate(`window.octoWork.deleteImChannel(${JSON.stringify(id)})`).catch(() => {});
  if (observerId)
    await evaluate(`window.octoWork.deleteImChannel(${JSON.stringify(observerId)})`).catch(
      () => {}
    );
  cdp.close();
  for (const client of connections) client.terminate();
  server.close();
  proxy.closeAllConnections();
  await new Promise((r) => proxy.close(r));
}
