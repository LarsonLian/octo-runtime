import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const packageName = "@mininglamp-oss/octo-runtime";
const registries = new Set(["https://registry.npmjs.org", "https://npm.pkg.github.com"]);
const sha512Integrity = /^sha512-[A-Za-z0-9+/]{86}==$/;

async function run(command, arguments_, options) {
  const { stdout } = await execute(command, arguments_, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    ...options
  });
  return stdout;
}

export function registryErrorCode(error) {
  try {
    const code = JSON.parse(error.stdout).error?.code;
    if (typeof code === "string") return code;
  } catch {}
  return (
    /npm (?:error|ERR!) code (E[A-Z0-9_]+)/.exec(error.stderr ?? "")?.[1] ??
    (typeof error.code === "string" ? error.code : "UNKNOWN")
  );
}

export async function readRegistryIntegrity(
  version,
  registry,
  { runCommand = run, timeout = 30_000, name = packageName } = {}
) {
  let output;
  try {
    output = await runCommand(
      "npm",
      [
        "view",
        `${name}@${version}`,
        "dist.integrity",
        "--json",
        `--registry=${registry}`,
        "--prefer-online",
        "--fetch-retries=0"
      ],
      { timeout }
    );
  } catch (error) {
    const code = registryErrorCode(error);
    if (code === "E404") return null;
    throw new Error(`Registry lookup failed (${code}): ${name}@${version} on ${registry}`);
  }
  const integrity = JSON.parse(output);
  if (typeof integrity !== "string" || !sha512Integrity.test(integrity)) {
    throw new Error(`Invalid registry integrity: ${name}@${version} on ${registry}`);
  }
  return integrity;
}

export async function checkRegistryVersion(
  { version, registry, integrity, wait = false, timeoutMs = 20 * 60_000 },
  {
    runCommand = run,
    sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now
  } = {}
) {
  if (!registries.has(registry)) throw new Error(`Unsupported registry: ${registry}`);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || version === "0.0.0") {
    throw new Error(`Invalid release version: ${version}`);
  }
  if (!sha512Integrity.test(integrity)) {
    throw new Error("Invalid archive integrity");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid lookup timeout");
  const deadline = now() + timeoutMs;
  for (;;) {
    const remote = await readRegistryIntegrity(version, registry, {
      runCommand,
      timeout: Math.max(1, Math.min(30_000, deadline - now()))
    });
    if (remote !== null) {
      if (remote !== integrity) {
        throw new Error(
          `${packageName}@${version} exists with different tarball integrity on ${registry}`
        );
      }
      return { exists: true, version, registry, integrity };
    }
    if (!wait) return { exists: false, version, registry };
    if (now() >= deadline) {
      throw new Error(
        `Upload was submitted, but ${packageName}@${version} is still unavailable on ${registry}. ` +
          "Registry processing or staged-version conflicts require investigation; do not blindly republish."
      );
    }
    await sleep(Math.min(15_000, deadline - now()));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [archive, version, registry, mode, ...extra] = process.argv.slice(2);
  if (
    !archive ||
    !version ||
    !registry ||
    (mode !== undefined && mode !== "--wait") ||
    extra.length
  ) {
    throw new Error("Usage: check-release-registry.mjs ARCHIVE VERSION REGISTRY [--wait]");
  }
  const integrity = `sha512-${createHash("sha512")
    .update(await readFile(archive))
    .digest("base64")}`;
  const result = await checkRegistryVersion({
    version,
    registry,
    integrity,
    wait: mode === "--wait"
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `exists=${result.exists}\n`);
  }
  console.log(JSON.stringify(result));
}
