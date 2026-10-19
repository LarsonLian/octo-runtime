import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { readRegistryIntegrity, registryErrorCode } from "./check-release-registry.mjs";

const execute = promisify(execFile);
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(version) {
  if (!stableVersion.test(version)) throw new Error(`不是稳定 SemVer：${version}`);
  return version.split(".").map(BigInt);
}

export function compareStableVersions(left, right) {
  const leftParts = parts(left);
  const rightParts = parts(right);
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function classifyVersion(candidate, latest) {
  if (latest === null) return "first";
  const comparison = compareStableVersions(candidate, latest);
  if (comparison > 0) return "newer";
  if (comparison < 0) return "older";
  return "equal";
}

export function selectHighestCompleteVersion(completeVersions) {
  if (completeVersions.length === 0)
    throw new Error("没有同时完成 npm 与 GitHub Release 的稳定版本");
  return [...new Set(completeVersions)].sort(compareStableVersions).at(-1);
}

function selectLatestFloor(...latestVersions) {
  const versions = latestVersions.filter((version) => version !== null && version !== undefined);
  return versions.length === 0 ? null : selectHighestCompleteVersion(versions);
}

function includeCandidate(state, candidate) {
  if (candidate === null) return state;
  if (candidate === "0.0.0" || !stableVersion.test(candidate)) {
    throw new Error(`候选版本不是可发布的稳定 SemVer：${candidate}`);
  }
  return {
    ...state,
    completeVersions: [...state.completeVersions, candidate]
  };
}

export async function reconcileLatest(
  client,
  {
    maxAttempts = 5,
    dryRun = false,
    candidate = null,
    retryDelay = () => new Promise((resolve) => setTimeout(resolve, 2000))
  } = {}
) {
  let observed;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = includeCandidate(await client.readState(), candidate);
    const latestFloor = selectLatestFloor(before.npmLatest, before.githubLatest);
    if (before.completeVersions.length === 0 && latestFloor !== null) {
      if (!dryRun && attempt < maxAttempts) {
        await retryDelay();
        continue;
      }
      throw new Error(
        `当前 latest ${latestFloor} 暂时没有完整 Release 资产：${JSON.stringify(before)}`
      );
    }
    const target = selectHighestCompleteVersion(before.completeVersions);
    const relation = classifyVersion(target, before.npmLatest);
    if (latestFloor !== null && compareStableVersions(target, latestFloor) < 0) {
      if (!dryRun && attempt < maxAttempts) {
        await retryDelay();
        continue;
      }
      throw new Error(
        `拒绝把 latest 从 ${latestFloor} 回退到暂时完整的 ${target}：${JSON.stringify(before)}`
      );
    }
    const actions = [
      ...(before.npmLatest === target ? [] : [["npm", target]]),
      ...(before.githubLatest === target ? [] : [["github", target]])
    ];

    if (dryRun) return { target, relation, attempts: attempt, actions };

    if (before.npmLatest !== target) await client.setNpmLatest(target);
    if (before.githubLatest !== target) await client.setGitHubLatest(target);

    observed = includeCandidate(await client.readState(), candidate);
    if (observed.completeVersions.length === 0) {
      if (attempt < maxAttempts) {
        await retryDelay();
        continue;
      }
      throw new Error(`写入后没有完整 Release 资产：${JSON.stringify(observed)}`);
    }
    const expected = selectHighestCompleteVersion(observed.completeVersions);
    if (observed.npmLatest === expected && observed.githubLatest === expected) {
      return { target: expected, relation, attempts: attempt };
    }
  }
  throw new Error(`latest 状态在 ${maxAttempts} 次协调后仍未收敛：${JSON.stringify(observed)}`);
}

async function run(command, arguments_, options) {
  const { stdout } = await execute(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  return stdout.trim();
}

async function npmView(runCommand, packageName, field) {
  let output;
  try {
    output = await runCommand(
      "npm",
      [
        "view",
        packageName,
        field,
        "--json",
        "--registry=https://registry.npmjs.org",
        "--prefer-online",
        "--fetch-retries=0"
      ],
      { timeout: 30_000 }
    );
  } catch (error) {
    if (registryErrorCode(error) === "E404") return null;
    throw error;
  }
  try {
    JSON.parse(output);
  } catch {
    throw new Error(`Invalid npm registry JSON response: ${packageName} ${field}`);
  }
  return output;
}

function stableLatest(output) {
  const version = output === null ? null : JSON.parse(output);
  return typeof version === "string" && version !== "0.0.0" && stableVersion.test(version)
    ? version
    : null;
}

export function createCommandClient({ packageName, repository, runCommand = run }) {
  async function readReleaseIntegrity(version, archive) {
    const directory = await mkdtemp(join(tmpdir(), "octo-release-integrity-"));
    try {
      await runCommand(
        "gh",
        [
          "release",
          "download",
          `v${version}`,
          "--pattern",
          archive,
          "--dir",
          directory,
          "--repo",
          repository
        ],
        { timeout: 120_000 }
      );
      return `sha512-${createHash("sha512")
        .update(await readFile(join(directory, archive)))
        .digest("base64")}`;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return {
    async readState() {
      const versionsOutput = await npmView(runCommand, packageName, "versions");
      const parsedVersions = versionsOutput === null ? [] : JSON.parse(versionsOutput);
      const npmVersions = (
        Array.isArray(parsedVersions) ? parsedVersions : [parsedVersions]
      ).filter(
        (version) =>
          typeof version === "string" && version !== "0.0.0" && stableVersion.test(version)
      );
      const latestOutput = await npmView(runCommand, `${packageName}@latest`, "version");
      const npmLatest = stableLatest(latestOutput);
      const releases = JSON.parse(
        await runCommand("gh", [
          "release",
          "list",
          "--limit",
          "1000",
          "--json",
          "tagName,isDraft,isPrerelease,isLatest",
          "--repo",
          repository
        ])
      );
      const byVersion = new Map(
        releases
          .filter(
            (release) =>
              !release.isDraft &&
              !release.isPrerelease &&
              release.tagName.startsWith("v") &&
              stableVersion.test(release.tagName.slice(1))
          )
          .map((release) => [release.tagName.slice(1), release])
      );
      const completeVersions = [];
      for (const version of npmVersions.sort(compareStableVersions).reverse()) {
        if (!byVersion.has(version)) continue;
        const release = JSON.parse(
          await runCommand("gh", [
            "release",
            "view",
            `v${version}`,
            "--json",
            "assets",
            "--repo",
            repository
          ])
        );
        const archive = `mininglamp-oss-octo-runtime-${version}.tgz`;
        if (release.assets.some((asset) => asset.name === archive)) {
          const npmIntegrity = await readRegistryIntegrity(version, "https://registry.npmjs.org", {
            runCommand,
            name: packageName
          });
          if (npmIntegrity === null) {
            throw new Error(`Missing npm archive integrity: ${packageName}@${version}`);
          }
          if ((await readReleaseIntegrity(version, archive)) !== npmIntegrity) {
            throw new Error(`GitHub Release archive integrity mismatch: ${packageName}@${version}`);
          }
          completeVersions.push(version);
          break;
        }
      }
      const latestRelease = releases.find((release) => release.isLatest);
      const githubLatest =
        latestRelease?.tagName.startsWith("v") && stableVersion.test(latestRelease.tagName.slice(1))
          ? latestRelease.tagName.slice(1)
          : null;
      return {
        completeVersions,
        npmLatest,
        githubLatest
      };
    },
    async setNpmLatest(version) {
      await runCommand("npm", [
        "dist-tag",
        "add",
        `${packageName}@${version}`,
        "latest",
        "--registry=https://registry.npmjs.org"
      ]);
    },
    async setGitHubLatest(version) {
      await runCommand("gh", ["release", "edit", `v${version}`, "--latest", "--repo", repository]);
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageName = process.env.OCTO_RELEASE_PACKAGE ?? "@mininglamp-oss/octo-runtime";
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("缺少 GITHUB_REPOSITORY");
  const dryRun = process.argv.includes("--dry-run");
  const candidateIndex = process.argv.indexOf("--candidate");
  const candidate = candidateIndex === -1 ? null : (process.argv[candidateIndex + 1] ?? null);
  if (dryRun && candidate === null) throw new Error("dry-run 缺少 --candidate VERSION");
  if (!dryRun && candidate !== null) throw new Error("--candidate 仅能与 --dry-run 一起使用");
  const result = await reconcileLatest(createCommandClient({ packageName, repository }), {
    dryRun,
    candidate
  });
  console.log(JSON.stringify(result));
}
