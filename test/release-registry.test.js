import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkRegistryVersion } from "../scripts/check-release-registry.mjs";

const integrity = `sha512-${createHash("sha512").update("archive").digest("base64")}`;
const npmRegistry = "https://registry.npmjs.org";
const packagesRegistry = "https://npm.pkg.github.com";
const options = { version: "1.0.1", registry: npmRegistry, integrity };

function registryError(code) {
  return Object.assign(new Error("Registry request failed"), {
    stdout: JSON.stringify({ error: { code } })
  });
}

test("both registries require matching immutable archive integrity and explicit registry selection", async () => {
  for (const registry of [npmRegistry, packagesRegistry]) {
    const result = await checkRegistryVersion(
      { ...options, registry },
      {
        runCommand: async (command, arguments_) => {
          assert.equal(command, "npm");
          assert.ok(arguments_.includes(`--registry=${registry}`));
          assert.ok(arguments_.includes("--prefer-online"));
          assert.ok(arguments_.includes("--fetch-retries=0"));
          return JSON.stringify(integrity);
        }
      }
    );
    assert.equal(result.exists, true);
    assert.equal(result.integrity, integrity);
  }
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
});

test("tag workflow directly publishes one verified artifact to npm and actual GitHub Packages", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/npm-publish.yml", import.meta.url),
    "utf8"
  );
  const release = await readFile(
    new URL("../.github/workflows/release-publish.yml", import.meta.url),
    "utf8"
  );
  assert.match(workflow, /fail-fast: false/);
  assert.match(
    workflow,
    /registry: npm\s+url: https:\/\/registry\.npmjs\.org\s+provenance: "true"/
  );
  assert.match(
    workflow,
    /registry: github-packages\s+url: https:\/\/npm\.pkg\.github\.com\s+provenance: "false"/
  );
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /matrix\.registry.*inputs\.tag/);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(workflow, /npm publish "\$ARCHIVE" --registry "\$REGISTRY"/);
  assert.doesNotMatch(workflow, /npm (?:stage|approve|reject)\b/);
  assert.match(
    workflow,
    /matrix\.registry == 'github-packages' && github\.token \|\| secrets\.NPM_TOKEN/
  );
  assert.match(release, /OCTO_RELEASE_GITHUB_PACKAGES: "true"/);
  assert.match(release, /\/\/npm\.pkg\.github\.com\/:_authToken=\\\$\{GH_PACKAGES_TOKEN\}/);
  assert.match(release, /printf '\\n%s\\n'/);
});

test(
  "promotion auth starts on a new line when setup-node config has no trailing newline",
  { skip: process.platform === "win32" },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "octo-promotion-auth-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const filename = join(directory, "npmrc");
    await writeFile(filename, "registry=https://registry.npmjs.org/");
    const release = await readFile(
      new URL("../.github/workflows/release-publish.yml", import.meta.url),
      "utf8"
    );
    const command = release.match(/^\s+printf[^\n]+NPM_CONFIG_USERCONFIG[^\n]+/m)?.[0].trim();
    assert.ok(command);
    execFileSync("sh", ["-c", command], {
      env: {
        ...process.env,
        NPM_CONFIG_USERCONFIG: filename,
        GH_PACKAGES_TOKEN: "fixture-only-must-not-expand"
      }
    });
    const configuration = await readFile(filename, "utf8");
    assert.deepEqual(configuration.trim().split("\n"), [
      "registry=https://registry.npmjs.org/",
      "//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}"
    ]);
  }
);
