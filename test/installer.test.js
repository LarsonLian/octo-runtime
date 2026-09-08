import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const macInstallerPath = join(root, "installers/macos/install.sh");
const windowsInstallerPath = join(root, "installers/windows/install.ps1");

test("macOS installer exposes the public positional-argument contract without network access", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX shell is not required on Windows");
    return;
  }

  const help = await execute("sh", [macInstallerPath, "--help"]);
  assert.match(help.stdout, /sh -s -- "https:\/\/SERVER" "octo_enroll_\.\.\."/);

  await assert.rejects(
    execute("sh", [macInstallerPath, "http://server.invalid", "octo_enroll_test"]),
    error => error.code === 2 && /SERVER_URL must use HTTPS/.test(error.stderr)
  );
});

test("installers use global npm, pass enrollment through stdin, and keep login in TypeScript", async () => {
  const [macInstaller, windowsInstaller] = await Promise.all([
    readFile(macInstallerPath, "utf8"),
    readFile(windowsInstallerPath, "utf8")
  ]);

  assert.match(macInstaller, /npm install --global --no-audit --no-fund "\$NPM_SPEC"/);
  assert.match(windowsInstaller, /install --global --no-audit --no-fund \$npmSpec/);
  assert.match(macInstaller, /printf '%s\\n' "\$ENROLLMENT_TOKEN" \| "\$CLI"/);
  assert.match(windowsInstaller, /\$EnrollmentToken \| & \$cli @setupArguments/);
  for (const source of [macInstaller, windowsInstaller]) {
    assert.match(source, /@mininglamp-oss\/octo-harness/);
    assert.match(source, /24/);
    assert.match(source, /--enroll-token-stdin/);
    assert.match(source, /login --help/);
    assert.match(source, /setup --help/);
    assert.doesNotMatch(source, /--token[= ]/);
    assert.doesNotMatch(source, /OCTO_HARNESS_INSTALL_ROOT/);
    assert.doesNotMatch(source, /versions\//);
  }
  assert.match(macInstaller, /--home "\$HARNESS_HOME"/);
  assert.match(windowsInstaller, /"--home", \$HarnessHome/);
  assert.match(macInstaller, /npm prefix --global/);
  assert.match(windowsInstaller, /prefix --global/);
  assert.match(macInstaller, /\.zprofile/);
  assert.match(windowsInstaller, /SetEnvironmentVariable\("Path"/);
  assert.ok(macInstaller.indexOf("setup --prepare-update") < macInstaller.indexOf("npm install --global"));
  assert.ok(windowsInstaller.indexOf("setup --prepare-update") < windowsInstaller.indexOf("install --global"));
  assert.match(windowsInstaller, /Test-FullyQualifiedWindowsPath/);
});

test("macOS installer resolves npm global bin, persists PATH, and invokes login", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX shell is not required on Windows");
    return;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "octo-installer-"));
  const fakeBin = join(fixtureRoot, "fake-bin");
  const npmPrefix = join(fixtureRoot, "npm-prefix");
  const harnessHome = join(fixtureRoot, "harness-home");
  const userHome = join(fixtureRoot, "user-home");
  const npmLog = join(fixtureRoot, "npm.log");
  const setupLog = join(fixtureRoot, "setup.log");
  await Promise.all([
    mkdir(fakeBin, { recursive: true }),
    mkdir(join(npmPrefix, "bin"), { recursive: true }),
    mkdir(userHome, { recursive: true })
  ]);

  const executables = {
    uname: "#!/bin/sh\nprintf 'Darwin\\n'\n",
    node: "#!/bin/sh\nprintf '24\\n'\n",
    npm: `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [ "$1" = "prefix" ]; then printf '%s\\n' "$FAKE_NPM_PREFIX"; fi
if [ "$1" = "install" ] && [ "\${FAKE_NPM_FAIL:-0}" = "1" ]; then exit 9; fi
`,
    "octo-harness": `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "--help" ]; then
  printf '%s\\n' 'login --enroll-token-stdin'
  exit 0
fi
if [ "$1" = "setup" ] && [ "$2" = "--help" ]; then
  printf '%s\\n' 'setup --prepare-update --recover-update'
  exit 0
fi
case " $* " in
  *" setup --prepare-update --wait-drained "*)
    printf 'PREPARE %s\\n' "$*" > "$FAKE_SETUP_LOG"
    exit 0
    ;;
  *" setup --recover-update --start "*)
    printf 'RECOVER %s\\n' "$*" >> "$FAKE_SETUP_LOG"
    exit 0
    ;;
esac
printf 'LOGIN %s\\n' "$*" >> "$FAKE_SETUP_LOG"
IFS= read -r token
printf '%s\\n' "$token" >> "$FAKE_SETUP_LOG"
if [ "\${FAKE_LOGIN_FAIL:-0}" = "1" ]; then exit 7; fi
`
  };
  await Promise.all(Object.entries(executables).map(async ([name, contents]) => {
    const target = name === "octo-harness" ? join(npmPrefix, "bin", name) : join(fakeBin, name);
    await writeFile(target, contents, "utf8");
    await chmod(target, 0o755);
  }));

  const installerEnvironment = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    SHELL: "/bin/zsh",
    HOME: userHome,
    OCTO_HARNESS_HOME: harnessHome,
    FAKE_NPM_PREFIX: npmPrefix,
    FAKE_NPM_LOG: npmLog,
    FAKE_SETUP_LOG: setupLog
  };
  await execute("sh", [macInstallerPath, "https://server.example", "octo_enroll_test"], {
    env: installerEnvironment
  });

  assert.match(await readFile(npmLog, "utf8"), /install --global --no-audit --no-fund @mininglamp-oss\/octo-harness@latest/);
  const setupInvocation = await readFile(setupLog, "utf8");
  assert.match(setupInvocation, /PREPARE .*setup --prepare-update --wait-drained/);
  assert.match(setupInvocation, new RegExp(`LOGIN --home ${harnessHome.replaceAll("/", "\\/")} --profile default login`));
  assert.match(setupInvocation, /--enroll-token-stdin --install-service --autostart --start --wait-online/);
  assert.match(setupInvocation, /octo_enroll_test/);
  const identityPath = join(harnessHome, "identity/runtime.json");
  await mkdir(join(harnessHome, "identity"), { recursive: true });
  await writeFile(identityPath, '{"schema_version":1,"runtime_id":"runtime-existing"}\n', "utf8");
  await execute("sh", [macInstallerPath, "https://server.example"], { env: installerEnvironment });
  assert.match(await readFile(setupLog, "utf8"), /LOGIN .*--enroll-token-stdin[\s\S]*\n\n$/);

  await assert.rejects(
    execute("sh", [macInstallerPath, "https://server.example"], {
      env: { ...installerEnvironment, FAKE_LOGIN_FAIL: "1" }
    }),
    error => error.code === 2 && /Restored the service after the updated login failed/.test(error.stdout)
  );
  assert.match(await readFile(setupLog, "utf8"), /RECOVER .*setup --recover-update --start/);
  assert.match(await readFile(join(userHome, ".zprofile"), "utf8"), new RegExp(npmPrefix.replaceAll("/", "\\/")));

  await assert.rejects(
    execute("sh", [macInstallerPath, "https://server.example", "octo_enroll_test"], {
      env: { ...installerEnvironment, FAKE_NPM_FAIL: "1" }
    }),
    error => error.code === 9 && /Restored the previous service/.test(error.stdout)
  );
  assert.match(await readFile(setupLog, "utf8"), /RECOVER .*setup --recover-update --start/);
});

test("installers attempt service recovery when npm update fails after drain", async () => {
  const [macInstaller, windowsInstaller] = await Promise.all([
    readFile(macInstallerPath, "utf8"),
    readFile(windowsInstallerPath, "utf8")
  ]);

  for (const source of [macInstaller, windowsInstaller]) {
    assert.match(source, /--recover-update/);
    assert.ok(source.indexOf("--prepare-update") < source.indexOf("install --global"));
    assert.ok(source.indexOf("install --global") < source.lastIndexOf("--recover-update"));
  }
});

test("root README publishes separate macOS and Windows one-line commands", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.match(readme, /install\.sh[\s\\]+\| sh -s --/);
  assert.match(readme, /\[scriptblock\]::Create\(\(irm .*install\.ps1\)\)/);
  assert.match(readme, /"https:\/\/im-test\.deepminer\.com\.cn"/);
  assert.match(readme, /"octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN"/);
  assert.match(readme, /npm install -g/);
  assert.doesNotMatch(readme, /~\/\.local\/share\/octo-harness/);
});

test("published root package requires Node.js 24 or newer", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.engines?.node, ">=24");
  assert.ok(packageJson.files.includes("apps/cli/README.md"));
});

test("Windows installer parses when PowerShell is available", async t => {
  const executable = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const escapedPath = windowsInstallerPath.replaceAll("'", "''");
  const command = [
    "$tokens=$null",
    "$errors=$null",
    `[Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors) | Out-Null`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }"
  ].join("; ");
  try {
    await execute(executable, ["-NoProfile", "-NonInteractive", "-Command", command]);
  } catch (error) {
    if (error.code === "ENOENT") {
      t.skip("PowerShell is not installed on this host");
      return;
    }
    throw error;
  }
});
