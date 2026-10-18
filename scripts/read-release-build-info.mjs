import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export function readReleaseBuildInfo(archive) {
  const filename = resolve(archive);
  return JSON.parse(
    execFileSync("tar", ["-xOf", basename(filename), "package/apps/cli/dist/build-info.json"], {
      cwd: dirname(filename),
      encoding: "utf8"
    })
  );
}
