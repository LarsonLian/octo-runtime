import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { runtimePaths } from "../apps/cli/dist/state.js";
import { temporaryDaemonEndpoint } from "../apps/cli/dist/temporary-daemon.js";
import { resolveDaemonRuntimePaths } from "../apps/daemon/dist/runtime-options.js";
import { runtimeControlEndpoint } from "@mininglamp-oss/octo-runtime-daemon/runtime-endpoint";
import { daemonHomePaths } from "@mininglamp-oss/octo-runtime-daemon/runtime/home";

test("正式 CLI 与 daemon 对同一 Windows Home 生成相同控制 Pipe", () => {
  const home = resolve("fixture/runtime-home");
  const cli = runtimePaths(home, "default", "win32");
  const daemon = resolveDaemonRuntimePaths(["--home", home], {}, "win32");

  assert.equal(cli.socket, daemon.socketPath);
  assert.match(cli.socket, /^\\\\\.\\pipe\\octo-runtime-[0-9a-f]{16}$/);
  assert.equal(cli.socket, runtimeControlEndpoint(home.toUpperCase(), "win32"));
});

test("正式 POSIX socket 保持原路径", () => {
  const home = resolve("fixture/runtime-home");
  const expected = resolve(home, "sockets/octo-runtime-daemon.sock");
  assert.equal(runtimePaths(home, "default", "linux").socket, expected);
  assert.equal(resolveDaemonRuntimePaths(["--home", home], {}, "linux").socketPath, expected);
});

test("SDK embedded Windows Pipe 保持独立命名空间", () => {
  const home = "C:\\Runtime\\Home";
  const resident = runtimeControlEndpoint(home, "win32");
  const embedded = daemonHomePaths(home, "win32").socket;
  assert.match(embedded, /^\\\\\.\\pipe\\octo-runtime-embedded-[0-9a-f]{16}$/);
  assert.notEqual(embedded, resident);
});

test("Playboard Windows Pipe 保持独立命名空间", () => {
  const directory = "C:\\Runtime\\Playboard";
  const temporary = temporaryDaemonEndpoint(directory, "win32");
  assert.match(temporary, /^\\\\\.\\pipe\\octo-playboard-[0-9a-f]{16}$/);
  assert.notEqual(temporary, runtimeControlEndpoint(directory, "win32"));
});

test("daemon 显式 socket flag 保持高于环境覆盖和默认派生", () => {
  const home = resolve("fixture/runtime-home");
  const environment = { OCTO_RUNTIME_SOCKET: "environment-socket" };
  assert.equal(
    resolveDaemonRuntimePaths(["--home", home], environment, "win32").socketPath,
    "environment-socket"
  );
  assert.equal(
    resolveDaemonRuntimePaths(["--home", home, "--socket", "flag-socket"], environment, "win32")
      .socketPath,
    "flag-socket"
  );
});
