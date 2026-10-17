import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const readManifest = async (directory) =>
  JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
const manifest = await readManifest(root);
const arguments_ = process.argv.slice(2);
if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== "--version")) {
  throw new Error("用法：node scripts/pack-release.mjs [--version X.Y.Z]");
}
const releaseVersion = arguments_[1] ?? manifest.version;
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(releaseVersion)) {
  throw new Error(`发行版本必须是稳定 SemVer，实际为 ${releaseVersion}`);
}
if (manifest.version !== "0.0.0") {
  throw new Error(`源码根 package.json.version 必须保持 0.0.0，实际为 ${manifest.version}`);
}
const workspaces = new Map();
for (const directory of ["apps", "packages"]) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, directory, entry.name);
    workspaces.set((await readManifest(path)).name, path);
  }
}

// Materialize the installed production graph, never the workspace symlinks or dev dependencies.
const packages = new Map();
async function locate(name, from) {
  if (workspaces.has(name)) return workspaces.get(name);
  for (let directory = from; ; directory = dirname(directory)) {
    try {
      return await realpath(join(directory, "node_modules", name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (dirname(directory) === directory) throw new Error(`缺少生产依赖 ${name}，来源 ${from}`);
  }
}
async function collect(name, from) {
  const path = await locate(name, from);
  const source = await readManifest(path);
  const previous = packages.get(name);
  if (previous) {
    if (previous.source.version !== source.version) {
      throw new Error(`发行依赖 ${name} 有多个版本，需要处理嵌套依赖后再发布`);
    }
    return;
  }
  packages.set(name, { path, source });
  for (const dependency of Object.keys(source.dependencies ?? {})) await collect(dependency, path);
  if (Object.keys(source.optionalDependencies ?? {}).length) {
    throw new Error(`发行依赖 ${name} 包含可选依赖，需要核对目标平台后再发布`);
  }
}
for (const name of Object.keys(manifest.dependencies)) await collect(name, root);
await collect((await readManifest(join(root, "apps/cli"))).name, root);

const temporary = await mkdtemp(join(tmpdir(), "octo-runtime-release-"));
const output = resolve(root, "dist/release");
try {
  for (const { path, source } of packages.values()) {
    const target = join(temporary, "node_modules", source.name);
    await mkdir(target, { recursive: true });
    if (workspaces.has(source.name)) {
      await cp(join(path, "dist"), join(target, "dist"), { recursive: true });
      if (source.exports?.["./config-schema.json"]) {
        await cp(join(path, "config-schema.json"), join(target, "config-schema.json"));
      }
      const { scripts, devDependencies, packageManager, ...metadata } = source;
      const dependencies = Object.fromEntries(
        Object.keys(source.dependencies ?? {}).map((name) => [
          name,
          workspaces.has(name) ? releaseVersion : packages.get(name).source.version
        ])
      );
      await writeFile(
        join(target, "package.json"),
        JSON.stringify(
          {
            ...metadata,
            private: true,
            version: releaseVersion,
            dependencies
          },
          null,
          2
        ) + "\n"
      );
    } else {
      await cp(path, target, {
        recursive: true,
        filter: (path) => path.split(/[\\/]/).at(-1) !== "node_modules"
      });
    }
  }
  for (const app of ["cli", "daemon"]) {
    await cp(join(root, "apps", app, "dist"), join(temporary, "apps", app, "dist"), {
      recursive: true
    });
  }
  await cp(join(root, "dist/public"), join(temporary, "dist/public"), { recursive: true });
  // 将公开的原始 schema 原样交付，接入方自行选择校验或类型生成工具。
  for (const target of Object.values(manifest.exports)) {
    if (typeof target !== "string" || !target.endsWith("/config-schema.json")) continue;
    await mkdir(dirname(join(temporary, target)), { recursive: true });
    await cp(join(root, target), join(temporary, target));
  }
  await cp(join(root, "apps/cli/README.md"), join(temporary, "apps/cli/README.md"));
  for (const file of ["LICENSE", "NOTICE"]) {
    await mkdir(dirname(join(temporary, file)), { recursive: true });
    await cp(join(root, file), join(temporary, file)).catch((error) => {
      if (file === "LICENSE" || error.code !== "ENOENT") throw error;
    });
  }
  await cp(join(root, "release/README.md"), join(temporary, "README.md"));
  const dependencies = Object.fromEntries(
    [...packages].map(([name, { source }]) => [
      name,
      workspaces.has(name) ? releaseVersion : source.version
    ])
  );
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify(
      {
        name: manifest.name,
        version: releaseVersion,
        description: manifest.description,
        repository: manifest.repository,
        homepage: manifest.homepage,
        bugs: manifest.bugs,
        ...(manifest.license ? { license: manifest.license } : {}),
        type: "module",
        bin: manifest.bin,
        exports: manifest.exports,
        engines: { node: manifest.engines.node },
        files: ["apps", "dist/public", "packages/*/config-schema.json", "LICENSE", "NOTICE"],
        publishConfig: { access: "public" },
        dependencies,
        bundleDependencies: Object.keys(dependencies)
      },
      null,
      2
    ) + "\n"
  );
  await mkdir(output, { recursive: true });
  const npm = process.env.npm_execpath?.endsWith("npm-cli.js")
    ? process.env.npm_execpath
    : join(
        dirname(process.execPath),
        process.platform === "win32"
          ? "node_modules/npm/bin/npm-cli.js"
          : "../lib/node_modules/npm/bin/npm-cli.js"
      );
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", output],
      { cwd: temporary, encoding: "utf8" }
    )
  )[0];
  if (result.bundled.length !== packages.size) throw new Error("npm 未完整打包生产依赖，禁止发布");
  console.log(join(output, result.filename));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
