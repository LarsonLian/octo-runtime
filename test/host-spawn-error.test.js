import assert from "node:assert/strict";
import test from "node:test";
import { spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";

test(
  "Host async spawn error rejects readiness promptly without terminating caller",
  { timeout: 3000 },
  async () => {
    const original = Object.getOwnPropertyDescriptor(process, "execPath");
    const started = Date.now();
    try {
      Object.defineProperty(process, "execPath", { ...original, value: "/octo-missing-host-S05" });
      await assert.rejects(
        spawnAdapterHost({ entrypoint: "unused", readyTimeoutMs: 10000 }),
        /ENOENT/
      );
      assert.ok(Date.now() - started < 2000);
    } finally {
      Object.defineProperty(process, "execPath", original);
    }
  }
);
