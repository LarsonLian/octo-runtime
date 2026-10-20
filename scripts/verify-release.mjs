import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { readReleaseBuildInfo } from "./read-release-build-info.mjs";

const execute = promisify(execFile);
const archive = resolve(process.argv[2]);
const root = resolve(import.meta.dirname, "..");
const live = process.argv.includes("--live");
const expectedCommitIndex = process.argv.indexOf("--expected-commit");
const expectedCommit =
  expectedCommitIndex === -1 ? null : (process.argv[expectedCommitIndex + 1] ?? null);
const requireClean = process.argv.includes("--require-clean");
if (expectedCommitIndex !== -1 && !/^[a-f0-9]{40,64}$/.test(expectedCommit ?? "")) {
  throw new Error("--expected-commit 必须提供完整的十六进制 commit");
}
// macOS Unix sockets have a short path limit; its default temp directory is too long.
const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "orc-"));
const npm = join(
  dirname(process.execPath),
  process.platform === "win32"
    ? "node_modules/npm/bin/npm-cli.js"
    : "../lib/node_modules/npm/bin/npm-cli.js"
);
let daemon;
let daemonExit;
async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      await execute("taskkill", ["/PID", String(daemon.pid), "/T", "/F"], {
        windowsHide: true,
        timeout: 10_000
      });
    } catch (error) {
      if (daemon.exitCode === null && daemon.signalCode === null) throw error;
    }
  } else {
    daemon.kill("SIGTERM");
    const timer = setTimeout(() => daemon.kill("SIGKILL"), 10_000);
    await daemonExit;
    clearTimeout(timer);
  }
  await daemonExit;
  assert.ok(daemon.exitCode !== null || daemon.signalCode !== null, "daemon 包装进程必须退出");
  daemon = undefined;
  daemonExit = undefined;
}
try {
  await execute(
    process.execPath,
    [
      npm,
      "install",
      "--global",
      "--prefix",
      directory,
      "--offline",
      "--cache",
      join(directory, "empty-cache"),
      "--no-audit",
      "--no-fund",
      archive
    ],
    { cwd: directory, timeout: 60_000 }
  );
  const installed = join(
    directory,
    process.platform === "win32" ? "node_modules" : "lib/node_modules",
    "@mininglamp-oss/octo-runtime"
  );
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.ok(Object.hasOwn(metadata.dependencies, "@mininglamp-oss/octo-runtime-extra-webui"));
  await assert.rejects(
    access(join(installed, "node_modules/@mininglamp-oss/octo-runtime-webui-extra")),
    { code: "ENOENT" }
  );
  assert.equal(metadata.license, "Apache-2.0");
  assert.equal(
    await readFile(join(installed, "LICENSE"), "utf8"),
    await readFile(join(root, "LICENSE"), "utf8")
  );
  assert.deepEqual((await readdir(join(installed, "apps"))).sort(), ["cli", "daemon"]);
  await access(join(installed, "apps/cli/dist/default_adapters.json"));
  await assert.rejects(access(join(installed, "config/adapters.json")), { code: "ENOENT" });
  // 隔离安装的 SDK 必须在没有复制 JSON 的情况下启动自己的直接 import 入口。
  const installedSdk = join(installed, "node_modules/@mininglamp-oss/octo-runtime-daemon");
  await assert.rejects(access(join(installedSdk, "dist/runtime/config/adapters.json")), {
    code: "ENOENT"
  });
  await execute(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from "node:assert/strict";
    const { createDaemonRuntime } = await import(process.env.OCTO_VERIFY_SDK_MODULE);
    const runtime = createDaemonRuntime({ appId: "release-sdk-check", home: process.env.OCTO_VERIFY_SDK_HOME });
    try {
      const health = await runtime.startAccount({ subject: { type: "user", id: "release-check" }, tenants: [{ id: "local" }] });
      assert.equal(health.local.adapterHostReady, true);
      const adapters = await runtime.listAdapters();
      assert.equal(adapters.length, 12);
      for (const adapter of adapters) {
        assert.equal(Object.hasOwn(adapter, "executionFeatures"), false, adapter.type);
        assert.equal(Object.hasOwn(adapter, "capabilities"), false, adapter.type);
      }
    } finally {
      await runtime.stop("quit");
    }
  `
    ],
    {
      cwd: directory,
      timeout: 30_000,
      env: {
        ...process.env,
        OCTO_VERIFY_SDK_MODULE: pathToFileURL(join(installedSdk, "dist/index.js")).href,
        OCTO_VERIFY_SDK_HOME: join(directory, "sdk-home")
      }
    }
  );
  await access(
    join(installed, "node_modules/@mininglamp-oss/octo-runtime-adapter-host/dist/runner.js")
  );
  assert.deepEqual(Object.keys(metadata.exports).sort(), [
    "./executor-core",
    "./extra",
    "./extras/channel-gateway/config-schema.json",
    "./extras/channel-wecom/config-schema.json",
    "./extras/webui/config-schema.json",
    "./protocol"
  ]);
  assert.equal(metadata.scripts, undefined);
  for (const [name, version] of Object.entries(metadata.dependencies)) {
    assert.doesNotMatch(version, /workspace:|link:|file:/);
    const dependency = JSON.parse(
      await readFile(join(installed, "node_modules", name, "package.json"), "utf8")
    );
    if (name.startsWith("@mininglamp-oss/")) {
      assert.equal(dependency.version, metadata.version);
      assert.equal(dependency.private, true);
    }
  }
  const cli = join(installed, "apps/cli/dist/index.js");
  const home = join(directory, "home");
  const run = (args) =>
    execute(process.execPath, [cli, ...args, "--home", home], { cwd: directory, timeout: 10_000 });
  assert.match((await run(["--help"])).stdout, /Octo Runtime CLI/);
  const build = JSON.parse(
    await readFile(join(installed, "apps/cli/dist/build-info.json"), "utf8")
  );
  assert.match(build.commit, /^[a-f0-9]{40,64}$/);
  if (expectedCommit !== null) assert.equal(build.commit, expectedCommit);
  if (requireClean) assert.equal(build.dirty, false);
  assert.match(build.buildTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(new Date(build.buildTime).toISOString(), build.buildTime);
  const archivedBuild = readReleaseBuildInfo(archive);
  assert.deepEqual(build, archivedBuild);
  const versionInfo = `${metadata.version}\ncommit:${build.commit.slice(0, 12)}${build.dirty ? " (dirty)" : ""}\nbuild:${build.buildTime}`;
  for (const args of [["--version"], ["-v"], ["version"]]) {
    assert.equal((await run(args)).stdout.trim(), versionInfo);
  }
  for (const args of [[], ["--help"], ["-h"], ["help"]]) {
    assert.ok((await run(args)).stdout.includes(`\nbuild:${build.buildTime}\n`));
  }
  assert.match(
    (await run([])).stdout,
    new RegExp(`Octo Runtime CLI \\(${metadata.version.replaceAll(".", "\\.")}\\)`)
  );
  assert.equal((await run(["daemon"])).stdout, (await run(["daemon", "--help"])).stdout);
  const playboardHelp = (await run(["playboard", "--help"])).stdout;
  assert.match(playboardHelp, /Examples:/);
  const reference = playboardHelp.split("Reference:\n  ")[1].trim();
  await access(reference);
  // Exercise the generated global command, not just the JS entrypoint.
  const command = join(
    directory,
    process.platform === "win32" ? "octo-runtime.cmd" : "bin/octo-runtime"
  );
  assert.match(
    (await execute(command, ["--help"], { cwd: directory, shell: process.platform === "win32" }))
      .stdout,
    /Octo Runtime CLI/
  );
  const daemonCommand = join(
    directory,
    process.platform === "win32" ? "octo-runtime-daemon.cmd" : "bin/octo-runtime-daemon"
  );
  const consumer = process.platform === "win32" ? directory : join(directory, "lib");
  await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');
  await cp(join(root, "test-support/public-extra/plugin.mts"), join(consumer, "plugin.mts"));
  await cp(join(root, "test-support/public-extra/executor.mts"), join(consumer, "executor.mts"));
  // 业务库只从离线发行包解析；TypeScript 与 Node 类型是开发工具依赖。
  await execute(
    process.execPath,
    [
      join(root, "node_modules/typescript/bin/tsc"),
      "plugin.mts",
      "executor.mts",
      "--module",
      "NodeNext",
      "--target",
      "ES2022",
      "--strict",
      "--skipLibCheck",
      "false",
      "--types",
      "node",
      "--typeRoots",
      join(root, "node_modules/@types"),
      "--outDir",
      "compiled"
    ],
    { cwd: consumer, timeout: 30_000 }
  );
  const publicImports = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const e = await import("@mininglamp-oss/octo-runtime/extra");
      const p = await import("@mininglamp-oss/octo-runtime/protocol");
      if (e.InvokeInput !== p.InvokeInput) throw Error("public exports mismatch");
      for (const name of ["executionFeatures", "adapterApprovalModes"])
        if (Object.hasOwn(p, name)) throw Error("removed protocol export: " + name);
      await import("./compiled/plugin.mjs");
      await (await import("./compiled/executor.mjs")).verifyExecutorCore();`
    ],
    { cwd: consumer }
  );
  assert.equal(publicImports.stderr, "");
  const resultFile = join(directory, "plugin-result.json");
  const marker = `PUBLIC_EXTRA_${Date.now()}`;
  if (live) {
    const response = await fetch("https://im-test.deepminer.com.cn/", {
      signal: AbortSignal.timeout(15_000)
    });
    assert.ok(response.ok, "im-test 必须可达；这项检查本身不证明业务链路已打通");
  }
  const save = spawn(process.execPath, [cli, "--home", home, "extraset", "public-extra"], {
    cwd: consumer,
    stdio: ["pipe", "ignore", "inherit"]
  });
  const saved = once(save, "exit");
  save.stdin.end(
    JSON.stringify({
      module: join(consumer, "compiled/plugin.mjs"),
      config: {
        resultFile,
        ...(live
          ? {
              input: {
                inputs: [{ type: "text", text: `Reply exactly ${marker}. Do not call tools.` }],
                contexts: {
                  schema: "octo.context-envelope/v3",
                  items: [
                    { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } }
                  ]
                },
                approvalMode: "full_access"
              }
            }
          : {})
      }
    })
  );
  assert.equal((await saved)[0], 0);
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const context = {
    schema: "octo.context-envelope/v3",
    items: [
      {
        namespace: "octo.control",
        name: "instructions",
        payload: { entries: [{ text: "我是明略科技的Octo助理" }] }
      }
    ]
  };
  for (const [name, config] of [
    [
      "channel-gateway",
      {
        bots: [
          {
            bot_id: "release-qa",
            api_url: "https://im-test.deepminer.com.cn/api",
            enabled: false,
            adapter: {},
            context
          }
        ]
      }
    ],
    [
      "channel-wecom",
      {
        bots: [
          {
            bot_id: "release-qa",
            enabled: false,
            adapter: { adapter_type: "codex", workdir: home },
            context
          }
        ]
      }
    ],
    [
      "webui",
      {
        port,
        sessionStorePath: join(home, "webui-sessions.json"),
        defaultProjectPath: home,
        context
      }
    ]
  ]) {
    const save = spawn(process.execPath, [cli, "--home", home, "extraset", name], {
      cwd: directory,
      stdio: ["pipe", "ignore", "pipe"]
    });
    const saved = once(save, "exit");
    save.stdin.end(
      JSON.stringify({ module: `@mininglamp-oss/octo-runtime-extra-${name}`, config })
    );
    assert.equal((await saved)[0], 0, name);
  }
  for (const [specifier, code] of [
    ["@mininglamp-oss/octo-runtime", "ERR_PACKAGE_PATH_NOT_EXPORTED"],
    ["@mininglamp-oss/octo-runtime/apps/cli/dist/index.js", "ERR_PACKAGE_PATH_NOT_EXPORTED"],
    [
      "@mininglamp-oss/octo-runtime/node_modules/@mininglamp-oss/octo-runtime-core/dist/index.js",
      "ERR_PACKAGE_PATH_NOT_EXPORTED"
    ],
    ["@mininglamp-oss/octo-runtime-core", "ERR_MODULE_NOT_FOUND"],
    ["@mininglamp-oss/octo-runtime-executor-core", "ERR_MODULE_NOT_FOUND"],
    ["@mininglamp-oss/octo-runtime-daemon", "ERR_MODULE_NOT_FOUND"]
  ]) {
    const result = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `try { await import(${JSON.stringify(specifier)}); process.exitCode = 1; } catch (error) { console.log(error.code); }`
      ],
      { cwd: consumer }
    );
    assert.equal(result.stdout.trim(), code, specifier);
  }
  daemon = spawn(daemonCommand, ["--home", home], {
    cwd: directory,
    shell: process.platform === "win32",
    stdio: ["ignore", "ignore", "pipe"]
  });
  daemonExit = once(daemon, "exit");
  let errors = "";
  daemon.stderr.on("data", (data) => {
    errors += data;
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error(errors);
    try {
      ready = JSON.parse((await run(["status"])).stdout).ready === true;
      if (ready) break;
    } catch {
      /* Wait for the isolated daemon socket. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors);
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    state = JSON.parse((await run(["status"])).stdout);
    if (
      ["channel-gateway", "channel-wecom", "webui"].every(
        (name) => state.extras[name]?.phase === "loaded"
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const name of ["channel-gateway", "channel-wecom", "webui"]) {
    assert.equal(state.extras[name]?.phase, "loaded", name);
    assert.deepEqual(state.extras[name].status.errors, [], name);
  }
  for (const name of ["channel-gateway", "channel-wecom"]) {
    assert.equal(state.extras[name].status.bots.length, 1, name);
    assert.equal(state.extras[name].status.bots[0].state, "stopped", name);
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  let pluginResult;
  for (let attempt = 0; attempt < (live ? 1200 : 100); attempt++) {
    try {
      pluginResult = JSON.parse(await readFile(resultFile, "utf8"));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(pluginResult?.schema, "octo.context-envelope/v3", errors);
  if (live) {
    assert.equal(pluginResult.terminal, "run.completed");
    assert.equal(pluginResult.answer.trim(), marker);
  }
  const adapters = JSON.parse((await run(["adapter", "list"])).stdout);
  assert.ok(adapters.some((adapter) => adapter.type === "codex"));
  assert.ok(adapters.some((adapter) => adapter.type === "claude-code"));
  await stopDaemon();
  await execute(
    process.execPath,
    [
      npm,
      "uninstall",
      "--global",
      "--prefix",
      directory,
      "--offline",
      "--cache",
      join(directory, "empty-cache"),
      "--no-audit",
      "--no-fund",
      metadata.name
    ],
    { cwd: directory, timeout: 60_000 }
  );
  await assert.rejects(access(installed), { code: "ENOENT" });
  await assert.rejects(access(command), { code: "ENOENT" });
  await access(home);
  console.log(
    JSON.stringify({
      version: metadata.version,
      offlineInstall: true,
      globalCli: true,
      commit: build.commit,
      dirty: build.dirty,
      privateImportsBlocked: true,
      publicTypesChecked: true,
      publicExecutorCoreChecked: true,
      externalExtraLoaded: true,
      allThreeBuiltinExtrasLoaded: true,
      liveAgentRun: live ? pluginResult.terminal : "not-run",
      daemonReady: ready,
      adapters: adapters.map((adapter) => adapter.type),
      uninstallRemovedPackage: true,
      uninstallPreservedHome: true
    })
  );
} finally {
  await stopDaemon();
  await rm(directory, { recursive: true, force: true });
}
