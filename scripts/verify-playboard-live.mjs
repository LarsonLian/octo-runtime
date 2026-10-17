import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Real Providers and the online test environment; no credentials are printed.
const endpoint = "https://im-test.deepminer.com.cn/";
assert.equal((await fetch(endpoint)).status, 200);
const directory = await mkdtemp(join(tmpdir(), "octo-playboard-live-"));
const cli = fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));
try {
  for (const type of ["codex", "openclaw"]) {
    const marker = `PLAYBOARD_${type.toUpperCase()}_OK`;
    const request = {
      inputs: [
        {
          type: "text",
          text: `Reply exactly ${marker}. Do not call tools, modify files, or send messages.`
        }
      ],
      contexts: {
        schema: "octo.context-envelope/v3",
        items: [
          { namespace: "octo.execution", name: "adapter", payload: { type } },
          { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } },
          {
            namespace: "octo.execution",
            name: "limits",
            payload: { run_timeout_ms: 120000, cancel_grace_ms: 1000 }
          }
        ]
      },
      protocol_mode: "canonical",
      workdir: directory
    };
    const child = spawn(
      process.execPath,
      [cli, "playboard", "--home", join(directory, type), "--profile", "live"],
      {
        cwd: directory,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, 150000);
      child.once("error", reject);
      child.once("close", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      child.stdin.end(JSON.stringify(request));
    });
    const frames = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const text = frames
      .filter((frame) => frame.type === "message.delta" || frame.type === "message.update")
      .map((frame) => frame.payload?.text ?? "")
      .join("");
    const terminal = frames.findLast((frame) =>
      ["run.completed", "run.failed", "run.cancelled"].includes(frame.type)
    );
    console.log(
      JSON.stringify({
        provider: type,
        endpoint,
        exitCode: code,
        terminal: terminal?.type,
        markerSeen: text.includes(marker),
        frameCount: frames.length,
        diagnosticsPresent: stderr.length > 0,
        ...(code !== 0
          ? {
              eventTypes: frames.map((frame) => frame.type),
              errorCodes: stderr.match(/\b[A-Z][A-Z_]{5,}\b/g) ?? []
            }
          : {})
      })
    );
    assert.equal(
      code,
      0,
      `${type} live execution failed; inspect Provider availability without publishing credentials`
    );
    assert.equal(terminal?.type, "run.completed");
    assert.ok(text.includes(marker), `${type} did not return the expected model response`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
