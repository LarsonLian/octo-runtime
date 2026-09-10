import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const playwrightPath = process.env.OCTO_PLAYWRIGHT_PATH;

test("inspect console browser workflows", { skip: !playwrightPath }, async () => {
  await run(process.execPath, ["scripts/inspect-ui.playwright.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: process.env,
    maxBuffer: 10 * 1024 * 1024
  });
});
