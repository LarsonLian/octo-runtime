import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Codex import and adapter creation do not inspect Home for computer-use labels", async () => {
  const moduleUrl = new URL("../packages/octo-runtime-adapter-codex/dist/index.js", import.meta.url).href;
  // A subprocess isolates the built-in filesystem hook and the exported singleton.
  await execFileAsync(process.execPath, ["--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    import { tmpdir } from "node:os";

    const home = join(tmpdir(), "octo-codex-no-config-probe-" + process.pid);
    process.env.CODEX_HOME = home;
    const originalRead = fs.readFileSync;
    let reads = 0;
    let configError;
    fs.readFileSync = function(file, ...args) {
      if (String(file) === join(home, "config.toml")) {
        reads++;
        if (configError) throw Object.assign(new Error(configError), { code: configError });
        return '[mcp_servers.computer-use]\\ncommand = "computer-use"\\n';
      }
      return originalRead.call(this, file, ...args);
    };
    syncBuiltinESMExports();

    const module = await import(${JSON.stringify(moduleUrl)});
    for (configError of [undefined, "ENOENT", "EACCES"]) {
      const adapter = module.createCodexAdapter({ env: { CODEX_HOME: home } });
      assert.equal(adapter.metadata.type, "codex");
      assert.ok(!adapter.metadata.executionFeatures.includes("tool.computer_use"));
    }
    assert.equal(reads, 0, "import and creation must leave Provider configuration to Codex");
  `], { timeout: 10000 });
});
