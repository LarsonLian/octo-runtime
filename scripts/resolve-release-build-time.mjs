import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readReleaseBuildInfo } from "./read-release-build-info.mjs";

export async function resolveReleaseBuildTime(version, commit, request = fetch) {
  const response = await request(
    `https://registry.npmjs.org/@mininglamp-oss%2focto-runtime/${version}`
  );
  if (response.status === 404) return new Date().toISOString();
  if (!response.ok) throw new Error(`Registry lookup failed: ${response.status}`);
  const metadata = await response.json();
  if (metadata.version !== version || metadata.name !== "@mininglamp-oss/octo-runtime") {
    throw new Error("Registry package identity does not match the release");
  }
  const archiveUrl = new URL(metadata.dist.tarball);
  if (archiveUrl.protocol !== "https:" || archiveUrl.hostname !== "registry.npmjs.org") {
    throw new Error("Unexpected release archive origin");
  }
  const archiveResponse = await request(archiveUrl);
  if (!archiveResponse.ok) throw new Error(`Archive download failed: ${archiveResponse.status}`);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  if (metadata.dist.integrity !== integrity)
    throw new Error("Published archive integrity mismatch");
  const directory = await mkdtemp(join(tmpdir(), "octo-release-build-time-"));
  try {
    const filename = join(directory, "release.tgz");
    await writeFile(filename, archive);
    const build = readReleaseBuildInfo(filename);
    if (build.commit !== commit || build.dirty !== false) {
      throw new Error("Published build source does not match the clean release commit");
    }
    if (build.buildTime === undefined) return "";
    if (
      typeof build.buildTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(build.buildTime) ||
      !Number.isFinite(Date.parse(build.buildTime)) ||
      new Date(build.buildTime).toISOString() !== build.buildTime
    ) {
      throw new Error("Published build timestamp is invalid");
    }
    return build.buildTime;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const buildTime = await resolveReleaseBuildTime(process.argv[2], process.argv[3]);
  await appendFile(process.env.GITHUB_OUTPUT, `build_time=${buildTime}\n`);
}
