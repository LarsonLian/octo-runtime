import assert from "node:assert/strict";
import test from "node:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { invocationInput } from "@mininglamp-oss/octo-runtime-protocol";
import { resolveAdapterModuleSpecifier } from "../packages/octo-runtime-adapter-host/dist/module-specifier.js";
import { invokeRequest, withTimeout } from "./runtime-fixture.js";

const entrypoint = resolve("packages/octo-runtime-adapter-host/dist/runner.js");
const fixture = resolve("test/fixtures/test-adapter.js");

test("manifest module specifiers preserve packages and existing URLs", () => {
  for (const specifier of [
    "adapter-package",
    "@scope/adapter",
    "@scope/adapter/entry.js",
    "file:///C:/adapter%20dir/adapter.mjs",
    "file:///tmp/adapter.mjs?version=1#entry",
    "node:fs",
    "https://example.invalid/adapter.mjs"
  ]) {
    assert.equal(
      resolveAdapterModuleSpecifier(specifier, resolve("config/adapters.json")),
      specifier
    );
  }
});

test("manifest module paths resolve relative to the manifest and encode URL characters", () => {
  const manifest = resolve("config/adapters.json");
  const file = resolve("fixtures/插件 空格 #%.mjs");
  assert.equal(
    resolveAdapterModuleSpecifier("../fixtures/插件 空格 #%.mjs", manifest),
    pathToFileURL(file).href
  );
  assert.equal(resolveAdapterModuleSpecifier(file, manifest), pathToFileURL(file).href);
  const url = new URL(resolveAdapterModuleSpecifier(file, manifest));
  assert.equal(url.search, "");
  assert.equal(url.hash, "");
  assert.match(url.pathname, /%20/);
  assert.match(url.pathname, /%23%25/);
});

test(
  "Windows drive and UNC paths convert without accessing a network share",
  {
    skip: process.platform !== "win32"
  },
  () => {
    const manifest = "C:\\config\\adapters.json";
    for (const path of ["D:\\插件 空格\\adapter#%.mjs", "D:/插件 空格/adapter#%.mjs"]) {
      assert.equal(
        resolveAdapterModuleSpecifier(path, manifest),
        "file:///D:/%E6%8F%92%E4%BB%B6%20%E7%A9%BA%E6%A0%BC/adapter%23%25.mjs"
      );
    }
    for (const path of [
      "\\\\server\\share\\插件 空格\\adapter#%.mjs",
      "//server/share/插件 空格/adapter#%.mjs"
    ]) {
      assert.equal(
        resolveAdapterModuleSpecifier(path, manifest),
        "file://server/share/%E6%8F%92%E4%BB%B6%20%E7%A9%BA%E6%A0%BC/adapter%23%25.mjs"
      );
    }
  }
);

test(
  "POSIX absolute paths retain native separator semantics",
  {
    skip: process.platform === "win32"
  },
  () => {
    assert.equal(
      resolveAdapterModuleSpecifier("/tmp/adapter\\name.mjs", "/config/adapters.json"),
      "file:///tmp/adapter%5Cname.mjs"
    );
  }
);

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "octo-manifest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "配置 目录");
  await mkdir(directory);
  const modulePath = join(root, "插件 空格 #%.mjs");
  await copyFile(fixture, modulePath);
  return { root, modulePath, manifest: join(directory, "adapters.json") };
}

async function writeManifest(manifest, module, exportName = "testAdapter") {
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      adapters: [{ module, export: exportName }]
    })
  );
}

async function startHost(t, root, manifest) {
  const host = await spawnAdapterHost({
    entrypoint,
    manifest,
    env: { ...process.env, OCTO_RUNTIME_HOME: root, OCTO_RUNTIME_LOGS_DIRECTORY: "" },
    readyTimeoutMs: 5_000
  });
  t.after(() => host.close());
  return host;
}

const forms = [
  ["native absolute path", (path) => path],
  ["forward-slash absolute path", (path) => path.replaceAll("\\", "/")],
  [
    "manifest-relative path",
    (path, manifest) => "./" + relative(dirname(manifest), path).replaceAll("\\", "/")
  ],
  ["file URL", (path) => pathToFileURL(path).href],
  ...(process.platform === "win32"
    ? [
        [
          "Windows manifest-relative path",
          (path, manifest) => ".\\" + relative(dirname(manifest), path)
        ]
      ]
    : [])
];

for (const [name, moduleSpecifier] of forms) {
  test(
    "manifest " + name + " reaches readiness, invokes and closes",
    { timeout: 15_000 },
    async (t) => {
      const { root, modulePath, manifest } = await createFixture(t);
      await writeManifest(manifest, moduleSpecifier(modulePath, manifest));
      const host = await startHost(t, root, manifest);
      assert.deepEqual(
        host.adapters.map((adapter) => adapter.type),
        ["test"]
      );
      const input = invocationInput(
        invokeRequest({
          prompt: "manifest regression",
          workdir: root,
          approvalMode: "full_access"
        }),
        "canonical",
        "test"
      );
      const original = structuredClone(input);
      const events = await withTimeout(
        (async () => {
          const events = [];
          for await (const event of host.client.invoke(input)) events.push(event);
          return events;
        })(),
        5_000,
        "manifest invocation timed out"
      );
      assert.deepEqual(input, original);
      assert.equal(events.at(-1).type, "run.completed");
      assert.equal(events.filter((event) => event.type === "run.completed").length, 1);
      assert.equal(
        events.findLast((event) => event.type === "message.update").payload.text,
        "Handled: manifest regression"
      );
      await withTimeout(host.close(), 3_000, "manifest Host close timed out");
      assert.ok(host.child.exitCode !== null || host.child.signalCode !== null);
    }
  );
}

test(
  "manifest package import keeps the runner's existing package resolution",
  { timeout: 10_000 },
  async (t) => {
    const { root, manifest } = await createFixture(t);
    await writeManifest(manifest, "@mininglamp-oss/octo-runtime-adapter-codex", "codexAdapter");
    // 只检查模块加载和注册；不 probe、不调用真实 Provider。
    const host = await startHost(t, root, manifest);
    assert.deepEqual(
      host.adapters.map((adapter) => adapter.type),
      ["codex"]
    );
    await withTimeout(host.close(), 3_000, "package Host close timed out");
  }
);

for (const [name, prepare, pattern] of [
  [
    "missing absolute module",
    async ({ root }) => ({ module: join(root, "missing adapter.mjs") }),
    /ERR_MODULE_NOT_FOUND/
  ],
  [
    "missing package",
    async () => ({ module: "octo-manifest-missing-package" }),
    /ERR_MODULE_NOT_FOUND/
  ],
  [
    "missing export",
    async ({ modulePath }) => ({ module: modulePath, exportName: "missingAdapter" }),
    /missing export missingAdapter/
  ],
  [
    "invalid adapter",
    async ({ modulePath }) => {
      await writeFile(modulePath, "export const testAdapter = {};");
      return { module: modulePath };
    },
    /is not an Octo Runtime adapter/
  ],
  [
    "invalid module syntax",
    async ({ modulePath }) => {
      await writeFile(modulePath, "export const testAdapter = ;");
      return { module: modulePath };
    },
    /SyntaxError/
  ]
]) {
  test("manifest reports " + name + " during readiness", { timeout: 10_000 }, async (t) => {
    const paths = await createFixture(t);
    const { module, exportName } = await prepare(paths);
    await writeManifest(paths.manifest, module, exportName);
    await assert.rejects(startHost(t, paths.root, paths.manifest), pattern);
  });
}
