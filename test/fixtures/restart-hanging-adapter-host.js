import { existsSync, readFileSync, writeFileSync } from "node:fs";

const manifestIndex = process.argv.indexOf("--manifest");
if (manifestIndex >= 0 && process.argv[manifestIndex + 1]) {
  const attemptPath = `${process.argv[manifestIndex + 1]}.host-attempt`;
  const attempt = existsSync(attemptPath) ? Number(readFileSync(attemptPath, "utf8")) + 1 : 1;
  writeFileSync(attemptPath, String(attempt));
  if (attempt === 2) {
    setInterval(() => undefined, 1_000);
  } else {
    await import("../../packages/octo-runtime-adapter-host/dist/runner.js");
  }
}
