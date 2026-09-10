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
  assert.match(url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/#/);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [name, viewport] of [
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", { width: 390, height: 844 }]
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      await page.goto(url, { waitUntil: "networkidle" });
      await page.locator("#events .event").first().waitFor();
      await page.reload({ waitUntil: "networkidle" });
      await page.locator("#events .event").first().waitFor();
      assert.equal(await page.locator("#state").textContent(), "live");
      assert.equal(await page.locator("#auth").isVisible(), false);
      assert.equal(await page.locator('nav button[data-view="events"]').getAttribute("class"), "active");
      await page.locator('nav button[data-view="logs"]').click();
      await page.locator("#logs .event").first().waitFor();
      await page.locator('nav button[data-view="runtime"]').click();
      assert.match(await page.locator("#runtime").textContent(), /adapterHost/);
      await page.locator('nav button[data-view="memory"]').click();
      assert.match(await page.locator("#memory-view").textContent(), /retainedBytes/);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      assert.equal(overflow, false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/octo-inspect-${name}.png`, fullPage: true });
      await page.close();
    }
    const authPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await authPage.goto(new URL(url).origin, { waitUntil: "domcontentloaded" });
    await authPage.locator("#auth.visible").waitFor();
    assert.match(await authPage.locator("#auth-message").textContent(), /token/i);
    const authBox = await authPage.locator("#auth").boundingBox();
    const mainBox = await authPage.locator("main").boundingBox();
    assert.ok(authBox && mainBox && authBox.y + authBox.height <= mainBox.y);
    await authPage.screenshot({ path: "/tmp/octo-inspect-auth.png", fullPage: true });
    await authPage.locator("#token").fill(url);
    await authPage.locator('#auth button[type="submit"]').click();
    await authPage.locator("#events .event").first().waitFor();
    assert.equal(await authPage.locator("#state").textContent(), "live");
    await authPage.close();
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  await new Promise(resolve => server.once("exit", resolve));
}
