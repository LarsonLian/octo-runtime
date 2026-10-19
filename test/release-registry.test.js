import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkRegistryVersion } from "../scripts/check-release-registry.mjs";

const integrity = `sha512-${createHash("sha512").update("archive").digest("base64")}`;
const npmRegistry = "https://registry.npmjs.org";
const options = { version: "1.0.1", registry: npmRegistry, integrity };

function registryError(code) {
  return Object.assign(new Error("Registry request failed"), {
    stdout: JSON.stringify({ error: { code } })
  });
}

test("npm 官方仓库校验不可变归档完整性并显式选择 registry", async () => {
  const result = await checkRegistryVersion(options, {
    runCommand: async (command, arguments_) => {
      assert.equal(command, "npm");
      assert.ok(arguments_.includes(`--registry=${npmRegistry}`));
      assert.ok(arguments_.includes("--prefer-online"));
      assert.ok(arguments_.includes("--fetch-retries=0"));
      return JSON.stringify(integrity);
    }
  });
  assert.equal(result.exists, true);
  assert.equal(result.integrity, integrity);
  await assert.rejects(
    checkRegistryVersion(options, {
      runCommand: async () =>
        JSON.stringify(`sha512-${createHash("sha512").update("other").digest("base64")}`)
    }),
    /different tarball integrity/i
  );
});

test("only E404 permits a new publish; authentication, network and malformed metadata fail closed", async () => {
  const missing = await checkRegistryVersion(options, {
    runCommand: async () => {
      throw registryError("E404");
    }
  });
  assert.equal(missing.exists, false);
  for (const code of ["E401", "E403", "ETIMEDOUT"]) {
    await assert.rejects(
      checkRegistryVersion(options, {
        runCommand: async () => {
          throw registryError(code);
        }
      }),
      new RegExp(code)
    );
  }
  for (const output of ["null", "{}", "invalid", '"sha1-abc"']) {
    await assert.rejects(checkRegistryVersion(options, { runCommand: async () => output }));
  }
});

test("post-publish verification waits for matching integrity with a bounded deadline", async () => {
  let elapsed = 0;
  let calls = 0;
  const dependencies = {
    now: () => elapsed,
    sleep: async (duration) => {
      elapsed += duration;
    },
    runCommand: async () => {
      if (++calls < 3) throw registryError("E404");
      return JSON.stringify(integrity);
    }
  };
  assert.equal(
    (await checkRegistryVersion({ ...options, wait: true, timeoutMs: 60_000 }, dependencies))
      .exists,
    true
  );
  assert.equal(calls, 3);
  elapsed = 0;
  await assert.rejects(
    checkRegistryVersion(
      { ...options, wait: true, timeoutMs: 20_000 },
      {
        ...dependencies,
        runCommand: async () => {
          throw registryError("E404");
        }
      }
    ),
    /Upload was submitted/
  );
  assert.ok(elapsed <= 20_000);
});

test("invalid versions and registry destinations never reach npm", async () => {
  const dependencies = { runCommand: async () => assert.fail("Must not call npm") };
  for (const version of ["0.0.0", "v1.0.0", "1.0.0-rc1"]) {
    await assert.rejects(checkRegistryVersion({ ...options, version }, dependencies));
  }
  await assert.rejects(
    checkRegistryVersion({ ...options, registry: "https://example.invalid" }, dependencies)
  );
  await assert.rejects(
    checkRegistryVersion({ ...options, registry: "https://npm.pkg.github.com" }, dependencies),
    /Unsupported registry/
  );
});

test("tag workflow 只向 npm 官方仓库直接发布且不请求 GitHub Packages 权限", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/npm-publish.yml", import.meta.url),
    "utf8"
  );
  const release = await readFile(
    new URL("../.github/workflows/release-publish.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /REGISTRY: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/);
  assert.match(workflow, /group: octo-runtime-package-publish-\$\{\{ inputs\.tag \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /npm publish "\$ARCHIVE" --registry "\$REGISTRY"/);
  assert.doesNotMatch(workflow, /npm (?:stage|approve|reject)\b/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /--ignore-scripts --provenance/);
  for (const content of [workflow, release]) {
    assert.doesNotMatch(
      content,
      /npm\.pkg\.github\.com|GH_PACKAGES_TOKEN|OCTO_RELEASE_GITHUB_PACKAGES|packages: (?:read|write)|matrix\.registry/
    );
  }
});
