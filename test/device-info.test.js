import test from "node:test";
import assert from "node:assert/strict";
import {
  collectRuntimeDeviceInfo,
  formatRuntimeDeviceInfo
} from "../apps/daemon/dist/server.js";

test("Runtime device metadata includes macOS product, kernel and CPU details", () => {
  assert.deepEqual(formatRuntimeDeviceInfo({
    platform: "darwin",
    platformRelease: "25.0.0",
    productVersion: "26.0.1",
    architecture: "arm64",
    cpuModel: "Apple M3 Pro",
    hostname: "developer-mac.local"
  }), {
    os: "macOS 26.0.1 (Darwin 25.0.0)",
    arch: "arm64 / Apple M3 Pro",
    hostname: "developer-mac.local"
  });
});

test("Runtime device metadata includes Linux distribution and kernel", () => {
  assert.deepEqual(formatRuntimeDeviceInfo({
    platform: "linux",
    platformRelease: "6.8.0-52-generic",
    linuxPrettyName: "Ubuntu 24.04.1 LTS",
    architecture: "x64",
    cpuModel: "AMD EPYC 7B13 64-Core Processor",
    hostname: "worker-01"
  }), {
    os: "Ubuntu 24.04.1 LTS (Linux 6.8.0-52-generic)",
    arch: "x64 / AMD EPYC 7B13 64-Core Processor",
    hostname: "worker-01"
  });
});

test("Runtime device metadata includes Windows edition and build", () => {
  assert.deepEqual(formatRuntimeDeviceInfo({
    platform: "win32",
    platformRelease: "10.0.22631",
    platformVersion: "Windows 11 Pro",
    architecture: "x64",
    cpuModel: "Intel(R) Core(TM) i7-13700K",
    hostname: "worker-win"
  }), {
    os: "Windows 11 Pro (10.0.22631)",
    arch: "x64 / Intel(R) Core(TM) i7-13700K",
    hostname: "worker-win"
  });
});

test("Runtime device metadata respects Worker field limits", () => {
  const device = formatRuntimeDeviceInfo({
    platform: "linux",
    platformRelease: "6.8.0",
    linuxPrettyName: "A".repeat(100),
    architecture: "x64",
    cpuModel: "B".repeat(100),
    hostname: "C".repeat(300)
  });
  assert.ok(Object.values(device).every(value => [...value].length <= 64));
});

test("collected Runtime device metadata is display-ready", () => {
  const device = collectRuntimeDeviceInfo();
  assert.ok(device.os.length > 0);
  assert.ok(device.arch.length > 0);
  assert.ok(device.hostname.length > 0);
  assert.notEqual(device.os, process.platform);
});
