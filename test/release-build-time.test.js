import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveReleaseBuildTime } from "../scripts/resolve-release-build-time.mjs";
import { readReleaseBuildInfo } from "../scripts/read-release-build-info.mjs";

const commit = "1234567890abcdef1234567890abcdef12345678";
const buildTime = "2026-10-18T12:34:56.789Z";

test("unpublished releases capture UTC build time; registry failures never invent recovery metadata", async () => {
  const before = Date.now();
  const timestamp = await resolveReleaseBuildTime(
    "1.0.1",
    commit,
    async () => new Response(null, { status: 404 })
  );
  assert.equal(new Date(timestamp).toISOString(), timestamp);
  assert.ok(Date.parse(timestamp) >= before && Date.parse(timestamp) <= Date.now());
  await assert.rejects(
    resolveReleaseBuildTime("1.0.1", commit, async () => new Response(null, { status: 500 })),
    /Registry lookup failed/
  );
});

test("same-version recovery reuses verified published metadata without weakening immutable integrity", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "octo-published-build-time-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "package/apps/cli/dist");
  await mkdir(dist, { recursive: true });
  const resolveBuild = async (build, alter = (metadata) => metadata) => {
    await writeFile(join(dist, "build-info.json"), JSON.stringify(build));
    const filename = join(directory, "package.tgz");
    execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: directory });
    const archive = await readFile(filename);
    const metadata = alter({
      name: "@mininglamp-oss/octo-runtime",
      version: "1.0.1",
      dist: {
        tarball: "https://registry.npmjs.org/package.tgz",
        integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`
      }
    });
    return resolveReleaseBuildTime("1.0.1", commit, async (url) =>
      String(url).endsWith(".tgz") ? new Response(archive) : Response.json(metadata)
    );
  };
  assert.equal(await resolveBuild({ commit, dirty: false, buildTime }), buildTime);
  assert.equal(await resolveBuild({ commit, dirty: false }), "");
  await assert.rejects(
    resolveBuild({ commit: "different", dirty: false, buildTime }),
    /source does not match/
  );
  await assert.rejects(resolveBuild({ commit, dirty: true, buildTime }), /source does not match/);
  for (const invalid of [null, "invalid", "2026-02-30T12:34:56.789Z"]) {
    await assert.rejects(
      resolveBuild({ commit, dirty: false, buildTime: invalid }),
      /timestamp is invalid/
    );
  }
  await assert.rejects(
    resolveBuild({ commit, dirty: false, buildTime }, (metadata) => ({
      ...metadata,
      version: "1.0.2"
    })),
    /identity/
  );
  await assert.rejects(
    resolveBuild({ commit, dirty: false, buildTime }, (metadata) => ({
      ...metadata,
      dist: { ...metadata.dist, integrity: "sha512-invalid" }
    })),
    /integrity mismatch/
  );
  await assert.rejects(
    resolveBuild({ commit, dirty: false, buildTime }, (metadata) => ({
      ...metadata,
      dist: { ...metadata.dist, tarball: "https://example.invalid/package.tgz" }
    })),
    /archive origin/
  );
});

test("archive metadata extraction avoids interpreting drive letters or parent-path colons as remote hosts", async (t) => {
  const prefix = process.platform === "win32" ? "octo-archive-" : "octo:archive-";
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "package/apps/cli/dist");
  await mkdir(dist, { recursive: true });
  const build = { commit, dirty: false, buildTime };
  await writeFile(join(dist, "build-info.json"), JSON.stringify(build));
  execFileSync("tar", ["-czf", "release.tgz", "package"], { cwd: directory });
  assert.deepEqual(readReleaseBuildInfo(join(directory, "release.tgz")), build);
});

test("GitHub-only recovery reuses immutable build metadata without sending its token to npm or foreign hosts", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "octo-packages-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "package/apps/cli/dist");
  await mkdir(dist, { recursive: true });
  await writeFile(
    join(dist, "build-info.json"),
    JSON.stringify({ commit, dirty: false, buildTime })
  );
  execFileSync("tar", ["-czf", "package.tgz", "package"], { cwd: directory });
  const archive = await readFile(join(directory, "package.tgz"));
  const metadata = {
    name: "@mininglamp-oss/octo-runtime",
    version: "1.0.1",
    dist: {
      tarball: "https://npm.pkg.github.com/package.tgz",
      integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`
    }
  };
  const calls = [];
  const request = async (url, options) => {
    calls.push(String(url));
    if (String(url).startsWith("https://registry.npmjs.org/")) {
      assert.equal(options, undefined);
      return new Response(null, { status: 404 });
    }
    assert.ok(String(url).startsWith("https://npm.pkg.github.com/"));
    assert.equal(options.headers.authorization, "Bearer fixture-token");
    if (String(url).endsWith(".tgz")) return new Response(archive);
    assert.equal(String(url), "https://npm.pkg.github.com/@mininglamp-oss%2focto-runtime");
    return Response.json({ name: metadata.name, versions: { "1.0.1": metadata } });
  };
  assert.equal(
    await resolveReleaseBuildTime("1.0.1", commit, request, {
      githubPackagesToken: "fixture-token"
    }),
    buildTime
  );
  assert.equal(calls.length, 3);
  metadata.dist.tarball = "https://example.invalid/package.tgz";
  await assert.rejects(
    resolveReleaseBuildTime("1.0.1", commit, request, {
      githubPackagesToken: "fixture-token"
    }),
    /archive origin/
  );
  await assert.rejects(
    resolveReleaseBuildTime(
      "1.0.1",
      commit,
      async (url) =>
        new Response(null, { status: String(url).includes("registry.npmjs.org") ? 404 : 403 }),
      {
        githubPackagesToken: "fixture-token"
      }
    ),
    /Registry lookup failed/
  );
  const before = Date.now();
  const timestamp = await resolveReleaseBuildTime(
    "1.0.1",
    commit,
    async (url) =>
      String(url).includes("registry.npmjs.org")
        ? new Response(null, { status: 404 })
        : Response.json({ name: metadata.name, versions: { "1.0.0": metadata } }),
    {
      githubPackagesToken: "fixture-token"
    }
  );
  assert.ok(Date.parse(timestamp) >= before);
});

test("malformed GitHub packuments never become synthetic missing versions or new build times", async () => {
  const name = "@mininglamp-oss/octo-runtime";
  for (const metadata of [
    null,
    {},
    { name, versions: [] },
    { name, versions: "invalid" },
    { name, versions: { "1.0.1": null } },
    { name, versions: { "1.0.1": "invalid" } },
    { name: "other", versions: {} }
  ]) {
    await assert.rejects(
      resolveReleaseBuildTime(
        "1.0.1",
        commit,
        async (url) =>
          String(url).includes("registry.npmjs.org")
            ? new Response(null, { status: 404 })
            : Response.json(metadata),
        {
          githubPackagesToken: "fixture-token"
        }
      ),
      /Invalid GitHub Packages/
    );
  }
});
