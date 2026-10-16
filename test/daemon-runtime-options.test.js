import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveDaemonRuntimePaths } from "../apps/daemon/dist/runtime-options.js";

test("CLI daemon resolves its own default manifest and the JSON Host runner", async () => {
  const paths = resolveDaemonRuntimePaths([], {});
  assert.equal(paths.hostEntrypoint,
    fileURLToPath(import.meta.resolve("@mininglamp-oss/octo-runtime-adapter-host/runner")));
  await access(paths.hostEntrypoint);
  assert.equal(paths.manifestPath, fileURLToPath(new URL("../apps/cli/dist/default_adapters.json", import.meta.url)));
  await access(paths.manifestPath);
});

test("explicit Host entrypoints retain flag and environment precedence", () => {
  const env = { OCTO_RUNTIME_ADAPTER_HOST: "custom/env-runner.js" };
  assert.equal(resolveDaemonRuntimePaths([], env).hostEntrypoint, resolve(env.OCTO_RUNTIME_ADAPTER_HOST));
  for (const flag of ["--adapter-host", "--host-entrypoint"]) {
    assert.equal(resolveDaemonRuntimePaths([flag, "custom/flag-runner.js"], env).hostEntrypoint,
      resolve("custom/flag-runner.js"));
  }
});
