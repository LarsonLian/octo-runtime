import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const playwrightPath = process.env.OCTO_PLAYWRIGHT_PATH;
if (!playwrightPath) throw new Error("OCTO_PLAYWRIGHT_PATH must point to playwright/index.mjs");
const { chromium } = await import(pathToFileURL(playwrightPath).href);

const server = spawn(process.execPath, ["scripts/inspect-ui-server.mjs"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  const lines = createInterface({ input: server.stdout });
  const first = await lines[Symbol.asyncIterator]().next();
  const url = first.value?.trim();
  assert.match(url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", { width: 390, height: 844 }]
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      let websocketCount = 0;
      let logRequestCount = 0;
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("websocket", () => { websocketCount += 1; });
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/logs") logRequestCount += 1; });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.getByText("WS 已连接", { exact: true }).waitFor();
      await page.locator("[data-index]").first().waitFor();

      const firstSeq = await sequenceNumber(page);
      await page.waitForTimeout(750);
      const nextSeq = await sequenceNumber(page);
      assert.ok(nextSeq > firstSeq, `expected newest sequence to increase: ${firstSeq} -> ${nextSeq}`);
      assert.ok(await page.locator("[data-index]").count() < 60);
      assert.equal(websocketCount, 1);

      await page.locator("#query").fill("adapter_type=claude_worker");
      await page.getByText("claude_worker", { exact: true }).first().waitFor();
      assert.equal(websocketCount, 1);
      await page.getByRole("button", { name: /仅看异常/ }).click();
      await page.getByText("invocation.failed", { exact: true }).waitFor();
      assert.equal(websocketCount, 1);
      await page.getByRole("button", { name: "重置" }).click();
      await page.locator("#query").fill("type=invocation.failed");
      await page.getByText("invocation.failed", { exact: true }).waitFor();

      const row = page.locator("[data-index]").first();
      await row.locator(":scope > [role=button]").click();
      assert.equal(await row.locator(":scope > [role=button]").getAttribute("aria-expanded"), "true");
      assert.match(await row.locator(".json-panel pre").textContent(), /"schema"/);
      assert.equal(await row.getByRole("button", { name: "重放 Invocation（无实现）" }).isDisabled(), true);
      assert.equal(await row.getByRole("button", { name: "复制 cURL / RPC（无实现）" }).isDisabled(), true);
      await row.getByRole("button", { name: "仅看此类事件" }).click();
      assert.match(await page.locator("#query").getAttribute("value") ?? "", /^type=/);
      await row.getByRole("button", { name: "过滤此次 AgentRun" }).click();
      assert.match(await page.locator("#query").getAttribute("value") ?? "", /^agent_run_id=/);
      await row.getByRole("button", { name: "过滤此次 AgentSession" }).click();
      assert.match(await page.locator("#query").getAttribute("value") ?? "", /^session_id=/);
      await row.getByRole("button", { name: "过滤当前 Stage" }).click();
      assert.match(await page.locator("#query").getAttribute("value") ?? "", /^stage=/);

      if (name === "desktop") {
        await page.getByRole("button", { name: "帮助文档" }).click();
        assert.match(await page.getByRole("dialog").textContent(), /Provider 产生、尚未规范化/);
        await page.screenshot({ path: `/tmp/octo-inspect-${name}-help.png`, fullPage: true });
        await page.getByRole("button", { name: "关闭" }).click();
      }
      await page.screenshot({ path: `/tmp/octo-inspect-${name}-events.png`, fullPage: true });

      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText("WS 已连接", { exact: true }).waitFor();
      await page.getByRole("tab", { name: "持久日志" }).click();
      await page.getByText("daemon.ready", { exact: true }).waitFor();
      assert.equal(logRequestCount, 1);
      assert.equal(websocketCount, 2);
      await page.getByRole("tab", { name: "运行时" }).click();
      assert.match(await page.locator(".json-view pre").textContent(), /adapterHost/);
      await page.getByRole("tab", { name: "内存" }).click();
      assert.match(await page.locator(".json-view pre").textContent(), /browserEventBytes/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/octo-inspect-${name}.png`, fullPage: true });
      await page.close();
    }

    const authPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await authPage.goto(new URL(url).origin, { waitUntil: "domcontentloaded" });
    await authPage.getByText(/需要 Capability Token/).waitFor();
    const authBox = await authPage.locator("form").boundingBox();
    const mainBox = await authPage.locator("main").boundingBox();
    assert.ok(authBox && mainBox && authBox.y + authBox.height <= mainBox.y);
    await authPage.getByLabel("Capability token").fill(url);
    await authPage.getByRole("button", { name: "连接" }).click();
    await authPage.getByText("WS 已连接", { exact: true }).waitFor();
    await authPage.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
}

async function sequenceNumber(page) {
  const text = await page.locator("[data-index] .sequence-cell b").first().textContent();
  return Number((text ?? "").replace("#", ""));
}
