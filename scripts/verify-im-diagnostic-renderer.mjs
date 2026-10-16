import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getChannelMessages } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";

// 将测试服务器返回的真实卡片交给桌面的原有渲染组件；不切换用户账号或服务地址。
assert.ok(
  process.env.OCTO_CHANNEL_QA_ACCOUNTS &&
    process.env.OCTO_CHANNEL_QA_GROUP &&
    process.env.OCTO_DIAGNOSTIC_CARD_ID
);
const account = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .find((b) => /^Bot Token:\s*bf_/m.test(b));
const token = account.match(/^Bot Token:\s*(.+)$/m)[1].trim();
assert.match(account, /^API Server:\s*https:\/\/im-test\.deepminer\.com\.cn\/api\s*$/m);
const messages = await getChannelMessages({
  apiUrl: "https://im-test.deepminer.com.cn/api",
  botToken: token,
  channelId: process.env.OCTO_CHANNEL_QA_GROUP,
  channelType: 2,
  limit: 100,
  pullMode: 0
});
const message = messages.find((m) => m.message_id === process.env.OCTO_DIAGNOSTIC_CARD_ID);
assert.equal(message?.type, 17);
assert.match(message.payload.plain, /结果待核查/);
const content = message.payload;
const props = {
  messageId: message.message_id,
  fromUid: message.from_uid,
  senderIsBot: true,
  channel: { channelId: process.env.OCTO_CHANNEL_QA_GROUP, channelType: 2 },
  content: {
    kind: "interactive-card",
    card: content.card,
    cardPlain: content.plain,
    cardProfile: content.profile,
    cardVersion: content.card_version,
    cardRenderProfile: content.render_profile
  }
};
const pages = await fetch("http://localhost:9222/json/list").then((r) => r.json());
const page = pages.find((p) => p.type === "page" && p.url.startsWith("http://localhost:5173"));
assert.ok(page);
const source = await fetch("http://localhost:5173/src/main.tsx").then((r) => r.text());
const react = source.match(/from "([^"]*\/deps\/react\.js[^"]*)"/)[1];
const reactDom = source.match(/from "([^"]*\/deps\/react-dom_client\.js[^"]*)"/)[1];
const kit =
  "/@fs" +
  fileURLToPath(new URL("../../octo-work-app/packages/im-kit/src/react/", import.meta.url));
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let seq = 0;
const pending = new Map(),
  exceptions = [];
ws.addEventListener("message", ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === "Runtime.exceptionThrown") exceptions.push(m.params.exceptionDetails.text);
  const entry = pending.get(m.id);
  if (!entry) return;
  pending.delete(m.id);
  clearTimeout(entry.timer);
  if (m.error || m.result?.exceptionDetails)
    entry.reject(new Error(JSON.stringify(m.error ?? m.result.exceptionDetails)));
  else entry.resolve(m.result);
});
const command = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("CDP timeout"));
      }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) =>
  (await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))
    .result.value;
try {
  await command("Runtime.enable");
  await evaluate(`(async()=>{
    const React=(await import(${JSON.stringify(react)})).default;
    const {createRoot}=(await import(${JSON.stringify(reactDom)})).default;
    const {ImKitProvider}=await import(${JSON.stringify(kit + "ImProvider.tsx")});
    const {AdaptiveCardMessage}=await import(${JSON.stringify(kit + "messages/AdaptiveCardMessage.tsx")});
    const mount=document.createElement('aside');mount.id='diagnostic-qa-renderer';
    Object.assign(mount.style,{position:'fixed',inset:'0',zIndex:'2147483647',background:'var(--color-bg,white)',padding:'48px',overflow:'auto'});
    document.body.appendChild(mount);const root=createRoot(mount);window.__diagnosticQaRoot=root;
    root.render(React.createElement(ImKitProvider,{host:{submitImCardAction:()=>Promise.reject(Error('QA_READ_ONLY'))},translate:key=>key,formatTime:{},currentUid:undefined},React.createElement('div',{style:{maxWidth:'600px',margin:'0 auto'}},React.createElement(AdaptiveCardMessage,{message:${JSON.stringify(props)}}))));
  })()`);
  const result = await evaluate(`new Promise(resolve=>{const end=Date.now()+10000;const poll=()=>{
    const el=document.querySelector('#diagnostic-qa-renderer');const rendered=!!el?.querySelector('.ac-adaptiveCard');
    if(rendered||Date.now()>end)resolve({rendered,text:el?.innerText,buttons:[...el.querySelectorAll('button')].map(b=>b.innerText),width:el.getBoundingClientRect().width});else setTimeout(poll,50);
  };poll()})`);
  assert.equal(result.rendered, true);
  assert.match(result.text, /结果待核查/);
  assert.match(result.text, /避免重复执行/);
  assert.doesNotMatch(result.buttons.join(" "), /重试|重新执行/);
  if (process.env.OCTO_DIAGNOSTIC_SCREENSHOT) {
    await evaluate("new Promise(resolve=>setTimeout(resolve,700))");
    const shot = await command("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.OCTO_DIAGNOSTIC_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  assert.equal(exceptions.length, 0);
  console.log(
    JSON.stringify({
      realRenderer: true,
      source: "im-test card",
      messageId: message.message_id,
      rendered: result.rendered,
      warningVisible: true,
      retryButtons: 0,
      exceptions: exceptions.length
    })
  );
} finally {
  await evaluate(
    "window.__diagnosticQaRoot?.unmount();delete window.__diagnosticQaRoot;document.querySelector('#diagnostic-qa-renderer')?.remove()"
  ).catch(() => {});
  ws.close();
}
