import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  classifyVersion,
  compareStableVersions,
  createCommandClient,
  reconcileLatest,
  selectHighestCompleteVersion
} from "../scripts/reconcile-release-latest.mjs";

const root = resolve(import.meta.dirname, "..");

function fixture(initial = {}) {
  const state = {
    completeVersions: [...(initial.completeVersions ?? [])],
    npmLatest: initial.npmLatest ?? null,
    githubLatest: initial.githubLatest ?? null
  };
  const actions = [];
  return {
    state,
    actions,
    client: {
      async readState() {
        return structuredClone(state);
      },
      async setNpmLatest(version) {
        actions.push(["npm", version]);
        state.npmLatest = version;
      },
      async setGitHubLatest(version) {
        actions.push(["github", version]);
        state.githubLatest = version;
      }
    }
  };
}

test("稳定版本关系显式区分 first、newer、equal、older", () => {
  assert.equal(classifyVersion("1.0.0", null), "first");
  assert.equal(classifyVersion("1.2.0", "1.1.9"), "newer");
  assert.equal(classifyVersion("1.2.0", "1.2.0"), "equal");
  assert.equal(classifyVersion("1.1.9", "1.2.0"), "older");
  assert.equal(compareStableVersions("100000000000000000000.0.0", "99999999999999999999.0.0"), 1);
  assert.throws(() => classifyVersion("1.2.0-beta.1", "1.1.0"), /稳定 SemVer/);
});

test("首次发布、升级和当前 latest 恢复均收敛且相等恢复零写入", async () => {
  const first = fixture({ completeVersions: ["1.0.0"] });
  assert.deepEqual(await reconcileLatest(first.client), {
    target: "1.0.0",
    relation: "first",
    attempts: 1
  });
  assert.deepEqual(first.actions, [
    ["npm", "1.0.0"],
    ["github", "1.0.0"]
  ]);

  first.state.completeVersions.push("1.1.0");
  assert.equal((await reconcileLatest(first.client)).relation, "newer");
  assert.equal(first.state.npmLatest, "1.1.0");
  assert.equal(first.state.githubLatest, "1.1.0");

  first.actions.length = 0;
  assert.equal((await reconcileLatest(first.client)).relation, "equal");
  assert.deepEqual(first.actions, []);
});

test("历史版本补发或恢复不改变共享 latest", async () => {
  const release = fixture({
    completeVersions: ["1.0.0", "1.2.0"],
    npmLatest: "1.2.0",
    githubLatest: "1.2.0"
  });
  const result = await reconcileLatest(release.client);
  assert.equal(result.target, "1.2.0");
  assert.deepEqual(release.actions, []);
});

for (const current of [
  { npmLatest: "1.2.0", githubLatest: "1.2.0" },
  { npmLatest: "1.1.0", githubLatest: "1.2.0" }
]) {
  test(`当前 latest 资产短暂缺失时拒绝回退：${JSON.stringify(current)}`, async () => {
    const release = fixture({ completeVersions: ["1.1.0"], ...current });
    await assert.rejects(
      () => reconcileLatest(release.client, { maxAttempts: 2, retryDelay: async () => {} }),
      /拒绝把 latest 从 1\.2\.0 回退/
    );
    assert.deepEqual(release.actions, []);
    assert.equal(release.state.npmLatest, current.npmLatest);
    assert.equal(release.state.githubLatest, current.githubLatest);
  });
}

test("当前 latest 资产替换完成后由有界重读恢复协调", async () => {
  const release = fixture({
    completeVersions: ["1.1.0"],
    npmLatest: "1.2.0",
    githubLatest: "1.2.0"
  });
  let retries = 0;
  const result = await reconcileLatest(release.client, {
    retryDelay: async () => {
      retries += 1;
      release.state.completeVersions.push("1.2.0");
    }
  });
  assert.equal(retries, 1);
  assert.equal(result.target, "1.2.0");
  assert.equal(result.attempts, 2);
  assert.deepEqual(release.actions, []);
});

test("唯一 latest 资产短暂消失后由有界重读恢复协调", async () => {
  const release = fixture({
    completeVersions: [],
    npmLatest: "1.2.0",
    githubLatest: "1.2.0"
  });
  let retries = 0;
  const result = await reconcileLatest(release.client, {
    retryDelay: async () => {
      retries += 1;
      release.state.completeVersions.push("1.2.0");
    }
  });
  assert.equal(retries, 1);
  assert.equal(result.target, "1.2.0");
  assert.equal(result.attempts, 2);
  assert.deepEqual(release.actions, []);
});

test("唯一 latest 资产持续缺失时有界失败且零写入", async () => {
  const release = fixture({
    completeVersions: [],
    npmLatest: "1.2.0",
    githubLatest: "1.2.0"
  });
  let retries = 0;
  await assert.rejects(
    () =>
      reconcileLatest(release.client, {
        maxAttempts: 2,
        retryDelay: async () => {
          retries += 1;
        }
      }),
    /当前 latest 1\.2\.0 暂时没有完整 Release 资产/
  );
  assert.equal(retries, 1);
  assert.deepEqual(release.actions, []);
});

test("写入后资产短暂消失时重读并复核最终状态", async () => {
  const release = fixture({
    completeVersions: ["1.2.0"],
    npmLatest: "1.1.0",
    githubLatest: "1.1.0"
  });
  let hidden = false;
  const client = {
    ...release.client,
    async setGitHubLatest(version) {
      await release.client.setGitHubLatest(version);
      release.state.completeVersions = [];
      hidden = true;
    }
  };
  const result = await reconcileLatest(client, {
    retryDelay: async () => {
      if (hidden) release.state.completeVersions.push("1.2.0");
    }
  });
  assert.equal(result.target, "1.2.0");
  assert.equal(result.attempts, 2);
  assert.deepEqual(release.actions, [
    ["npm", "1.2.0"],
    ["github", "1.2.0"]
  ]);
});

test("dry-run 使用同一决策并保持 npm 与 GitHub 零写入", async () => {
  const release = fixture({
    completeVersions: ["1.0.0"],
    npmLatest: "1.0.0",
    githubLatest: "1.0.0"
  });
  assert.deepEqual(
    await reconcileLatest(release.client, {
      dryRun: true,
      candidate: "1.2.0"
    }),
    {
      target: "1.2.0",
      relation: "newer",
      attempts: 1,
      actions: [
        ["npm", "1.2.0"],
        ["github", "1.2.0"]
      ]
    }
  );
  assert.deepEqual(release.actions, []);
  assert.equal(release.state.npmLatest, "1.0.0");
  assert.equal(release.state.githubLatest, "1.0.0");
});

for (const order of [
  ["1.1.0", "1.2.0"],
  ["1.2.0", "1.1.0"]
]) {
  test(`两个版本按 ${order.join(" -> ")} 完成交付后 latest 不回退`, async () => {
    const release = fixture();
    for (const version of order) {
      release.state.completeVersions.push(version);
      await reconcileLatest(release.client);
    }
    assert.equal(release.state.npmLatest, "1.2.0");
    assert.equal(release.state.githubLatest, "1.2.0");
  });
}

test("写入期间出现更高完整版本时重新读取并在有界循环内修复", async () => {
  const release = fixture({ completeVersions: ["1.1.0"] });
  let injected = false;
  const client = {
    ...release.client,
    async setGitHubLatest(version) {
      await release.client.setGitHubLatest(version);
      if (!injected) {
        injected = true;
        release.state.completeVersions.push("1.2.0");
      }
    }
  };
  const result = await reconcileLatest(client);
  assert.equal(result.target, "1.2.0");
  assert.equal(result.attempts, 2);
  assert.equal(release.state.npmLatest, "1.2.0");
  assert.equal(release.state.githubLatest, "1.2.0");
});

test("最高完整版本只接受稳定 SemVer 并拒绝空集合", () => {
  assert.equal(selectHighestCompleteVersion(["1.9.0", "1.10.0", "1.10.0"]), "1.10.0");
  assert.throws(() => selectHighestCompleteVersion([]), /没有同时完成/);
});

test("命令边界 fixture 只把最高完整版本提升为 npm 与 GitHub latest", async () => {
  const calls = [];
  let npmLatest = "1.0.0";
  let githubLatest = "1.0.0";
  const runCommand = async (command, arguments_) => {
    calls.push([command, ...arguments_]);
    if (command === "npm" && arguments_[0] === "view" && arguments_[2] === "versions") {
      return JSON.stringify(["0.0.0-stage", "1.0.0", "1.2.0", "1.3.0", "1.4.0-rc.1"]);
    }
    if (command === "npm" && arguments_[0] === "view" && arguments_[2] === "version") {
      return JSON.stringify(npmLatest);
    }
    if (command === "npm" && arguments_[0] === "dist-tag") {
      npmLatest = arguments_[2].split("@").at(-1);
      return "";
    }
    if (command === "npm" && arguments_[2] === "dist.integrity") {
      return JSON.stringify(`sha512-${createHash("sha512").update("fixture").digest("base64")}`);
    }
    if (command === "gh" && arguments_[1] === "download") {
      await writeFile(
        resolve(
          arguments_[arguments_.indexOf("--dir") + 1],
          arguments_[arguments_.indexOf("--pattern") + 1]
        ),
        "fixture"
      );
      return "";
    }
    if (command === "gh" && arguments_[1] === "list") {
      return JSON.stringify(
        ["1.0.0", "1.2.0", "1.3.0"].map((version) => ({
          tagName: `v${version}`,
          isDraft: false,
          isPrerelease: false,
          isLatest: version === githubLatest
        }))
      );
    }
    if (command === "gh" && arguments_[1] === "view") {
      const version = arguments_[2].slice(1);
      return JSON.stringify({
        assets: version === "1.3.0" ? [] : [{ name: `mininglamp-oss-octo-runtime-${version}.tgz` }]
      });
    }
    if (command === "gh" && arguments_[1] === "edit") {
      githubLatest = arguments_[2].slice(1);
      return "";
    }
    throw new Error(`未处理的 fixture 命令：${command} ${arguments_.join(" ")}`);
  };
  const client = createCommandClient({
    packageName: "@mininglamp-oss/octo-runtime",
    repository: "Mininglamp-OSS/octo-runtime",
    runCommand
  });
  assert.equal((await reconcileLatest(client)).target, "1.2.0");
  assert.equal(npmLatest, "1.2.0");
  assert.equal(githubLatest, "1.2.0");
  assert.ok(calls.some((call) => call.join(" ").includes("dist-tag add")));
  assert.ok(calls.some((call) => call.join(" ").includes("release edit v1.2.0 --latest")));
  assert.ok(!calls.some((call) => call.join(" ").includes("release edit v1.3.0 --latest")));
  assert.ok(
    calls
      .filter(([command]) => command === "npm")
      .every((call) => call.includes("--registry=https://registry.npmjs.org"))
  );
  assert.ok(!calls.some((call) => call.join(" ").includes("1.4.0-rc.1")));
});

test("workflow 将不可变发布、Release 修复和共享 promotion 分离", async () => {
  const npmWorkflow = await readFile(resolve(root, ".github/workflows/npm-publish.yml"), "utf8");
  const releaseWorkflow = await readFile(
    resolve(root, ".github/workflows/release-publish.yml"),
    "utf8"
  );
  const publishReleaseJob = releaseWorkflow
    .split("\n  promote-latest:")[0]
    .split("\n  publish-release:")[1];
  assert.match(npmWorkflow, /--tag "release-\$VERSION"/);
  assert.doesNotMatch(npmWorkflow, /npm publish[^\n]+--tag latest/);
  assert.match(npmWorkflow, /node scripts\/check-release-registry\.mjs/);
  assert.match(npmWorkflow, /"\$REGISTRY" --wait/);
  assert.match(npmWorkflow, /node scripts\/resolve-release-build-time\.mjs "\$VERSION" "\$SHA"/);
  assert.match(npmWorkflow, /build_time: \$\{\{ needs\.validate\.outputs\.build_time \}\}/);
  const ciWorkflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ciWorkflow, /OCTO_RUNTIME_BUILD_TIME: \$\{\{ inputs\.build_time \|\| '' \}\}/);
  assert.match(releaseWorkflow, /'octo-runtime-latest-promotion'/);
  assert.match(releaseWorkflow, /octo-runtime-latest-dry-run-/);
  assert.doesNotMatch(publishReleaseJob, /concurrency:/);
  assert.match(releaseWorkflow, /node scripts\/reconcile-release-latest\.mjs/);
  assert.match(releaseWorkflow, /--dry-run --candidate "\$VERSION"/);
  assert.doesNotMatch(releaseWorkflow, /release edit "\$TAG"[^\n]+--latest=false/);
});

test("新稳定版自动把 npm latest 推进到 1.0.2，RC 候选不能写入 latest", async () => {
  const current = fixture({
    completeVersions: ["1.0.1", "1.0.2"],
    npmLatest: "1.0.1",
    githubLatest: "1.0.1"
  });
  assert.equal((await reconcileLatest(current.client)).target, "1.0.2");
  assert.equal(current.state.npmLatest, "1.0.2");
  current.actions.length = 0;
  await assert.rejects(
    reconcileLatest(current.client, { dryRun: true, candidate: "1.0.3-rc.1" }),
    /稳定 SemVer/
  );
  assert.deepEqual(current.actions, []);
});

test("单 registry 协调器只查询 npm，并在晋升前核对 Release 附件完整性", async () => {
  const calls = [];
  let invalidIntegrity;
  let corruptRelease = false;
  const client = createCommandClient({
    packageName: "@mininglamp-oss/octo-runtime",
    repository: "Mininglamp-OSS/octo-runtime",
    runCommand: async (command, arguments_) => {
      calls.push([command, ...arguments_]);
      if (command === "npm") {
        if (arguments_[0] === "dist-tag") return "";
        if (arguments_[2] === "versions") return JSON.stringify(["1.1.0", "1.2.0"]);
        if (arguments_[2] === "version") return JSON.stringify("0.0.0-stage");
        if (arguments_[2] === "dist.integrity")
          return JSON.stringify(
            invalidIntegrity ?? `sha512-${createHash("sha512").update("same").digest("base64")}`
          );
      }
      if (command === "gh" && arguments_[1] === "download") {
        await writeFile(
          resolve(
            arguments_[arguments_.indexOf("--dir") + 1],
            arguments_[arguments_.indexOf("--pattern") + 1]
          ),
          corruptRelease ? "" : "same"
        );
        return "";
      }
      if (command === "gh" && arguments_[1] === "list")
        return JSON.stringify(
          ["1.1.0", "1.2.0"].map((version) => ({
            tagName: `v${version}`,
            isDraft: false,
            isPrerelease: false,
            isLatest: false
          }))
        );
      if (command === "gh" && arguments_[1] === "view")
        return JSON.stringify({
          assets: [{ name: `mininglamp-oss-octo-runtime-${arguments_[2].slice(1)}.tgz` }]
        });
      throw new Error(`Unexpected command ${command} ${arguments_.join(" ")}`);
    }
  });
  assert.deepEqual(await client.readState(), {
    completeVersions: ["1.2.0"],
    npmLatest: null,
    githubLatest: null
  });
  await client.setNpmLatest("1.2.0");
  assert.ok(
    calls.some(
      (call) => call.includes("dist-tag") && call.includes("--registry=https://registry.npmjs.org")
    )
  );
  assert.ok(
    !calls.some((call) => call.some((argument) => argument.includes("npm.pkg.github.com")))
  );
  for (const invalid of ["", "sha1-same", "sha512-short"]) {
    invalidIntegrity = invalid;
    await assert.rejects(client.readState(), /Invalid registry integrity/);
  }
  invalidIntegrity = undefined;
  corruptRelease = true;
  await assert.rejects(client.readState(), /GitHub Release archive integrity mismatch/);
});

test("npm 返回空或无效 JSON 时明确报错且不写入 latest", async () => {
  for (const field of ["versions", "version"]) {
    for (const output of ["", " ", "invalid"]) {
      const client = createCommandClient({
        packageName: "@mininglamp-oss/octo-runtime",
        repository: "Mininglamp-OSS/octo-runtime",
        runCommand: async (command, arguments_) => {
          assert.equal(command, "npm");
          assert.equal(arguments_[0], "view");
          return arguments_[2] === field ? output : JSON.stringify(["1.0.1"]);
        }
      });
      await assert.rejects(reconcileLatest(client), /Invalid npm registry JSON response/);
    }
  }
});

test("Windows 发行验收通过 taskkill 回收全局 daemon shim 的进程树", async () => {
  const verifier = await readFile(resolve(root, "scripts/verify-windows-release.mjs"), "utf8");
  const workflow = await readFile(resolve(root, ".github/workflows/ci.yml"), "utf8");
  const cliManifest = JSON.parse(await readFile(resolve(root, "apps/cli/package.json"), "utf8"));
  const daemonManifest = JSON.parse(
    await readFile(resolve(root, "apps/daemon/package.json"), "utf8")
  );
  const invocationManifest = await readFile(
    resolve(root, "packages/octo-runtime-daemon/src/invocation-manifest.ts"),
    "utf8"
  );
  assert.match(verifier, /execute\("taskkill", \["\/PID", String\(daemon\.pid\), "\/T", "\/F"\]/);
  assert.match(verifier, /await stopDaemon\(\)/);
  assert.match(workflow, /name: Verify release package \(windows-latest\)/);
  assert.match(workflow, /git config --global core\.autocrlf false/);
  assert.match(workflow, /node scripts\/verify-windows-release\.mjs/);
  assert.match(workflow, /needs: \[check, verify-windows-release\]/);
  assert.match(invocationManifest, /encoding: "utf8", timeout: 10_000, windowsHide: true/);
  assert.doesNotMatch(cliManifest.scripts.build, /\bchmod\b/);
  assert.doesNotMatch(daemonManifest.scripts.build, /\bchmod\b/);
});
