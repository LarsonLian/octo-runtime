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
const posixInstallerPath = join(root, "installers/posix/install.sh");
const windowsInstallerPath = join(root, "installers/windows/install.ps1");

test("POSIX installer exposes the macOS/Linux positional-argument contract without network access", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX shell is not required on Windows");
    return;
  }

  const help = await execute("sh", [posixInstallerPath, "--help"]);
  assert.match(help.stdout, /current macOS or Linux user/);
  assert.match(help.stdout, /sh -s -- "https:\/\/SERVER" "octo_enroll_\.\.\."/);

  await assert.rejects(
    execute("sh", [posixInstallerPath, "http://server.invalid", "octo_enroll_test"]),
    error => error.code === 2 && /SERVER_URL must use HTTPS/.test(error.stderr)
  );

  await assert.rejects(
    execute("sh", [posixInstallerPath, "https://server.invalid", "octo_enroll_test"], {
      env: { ...process.env, OCTO_HARNESS_PROFILE: ".." }
    }),
    error => error.code === 2 && /must start with a letter or digit/.test(error.stderr)
  );

  await assert.rejects(
    execute("sh", [posixInstallerPath, "https://server.invalid", "octo_enroll_test"], {
      env: { ...process.env, OCTO_HARNESS_PROFILE: "logs" }
    }),
    error => error.code === 2 && /conflicts with Harness Home infrastructure/.test(error.stderr)
  );
});

test("Linux installer fails clearly instead of elevating when Node.js 24 is unavailable", async t => {
  if (process.platform === "win32") {
    t.skip("POSIX shell is not required on Windows");
    return;
  }

  const fixtureRoot = await mkdtemp(join(tmpdir(), "octo-linux-prerequisite-"));
  const fakeBin = join(fixtureRoot, "bin");
  await mkdir(fakeBin, { recursive: true });
  for (const [name, contents] of Object.entries({
    uname: "#!/bin/sh\nprintf 'Linux\\n'\n",
    node: "#!/bin/sh\nprintf '22\\n'\n"
  })) {
    const target = join(fakeBin, name);
    await writeFile(target, contents, "utf8");
    await chmod(target, 0o755);
  }

  await assert.rejects(
    execute("sh", [posixInstallerPath, "https://server.example", "octo_enroll_test"], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        HOME: fixtureRoot
      }
    }),
    error => error.code === 2 &&
      /trusted distribution or version manager/.test(error.stderr) &&
      /does not use sudo or add package repositories/.test(error.stderr)
  );
});

test("installers use global npm, pass enrollment through stdin, and keep login in TypeScript", async () => {
  const [posixInstaller, windowsInstaller] = await Promise.all([
    readFile(posixInstallerPath, "utf8"),
    readFile(windowsInstallerPath, "utf8")
  ]);

  assert.match(posixInstaller, /npm install --global --no-audit --no-fund "\$NPM_SPEC"/);
  assert.match(windowsInstaller, /install --global --no-audit --no-fund \$npmSpec/);
  assert.match(posixInstaller, /printf '%s\\n' "\$ENROLLMENT_TOKEN" \| "\$CLI"/);
  assert.match(windowsInstaller, /\$EnrollmentToken \| & \$cli @loginArguments/);
  for (const source of [posixInstaller, windowsInstaller]) {
    assert.match(source, /@mininglamp-oss\/octo-harness/);
    assert.match(source, /24/);
    assert.match(source, /--enroll-token-stdin/);
    assert.match(source, /login --help/);
    assert.doesNotMatch(source, /--token[= ]/);
    assert.doesNotMatch(source, /OCTO_HARNESS_INSTALL_ROOT/);
    assert.doesNotMatch(source, /versions\//);
  }
  assert.match(posixInstaller, /--home "\$HARNESS_HOME"/);
  assert.match(windowsInstaller, /"--home", \$HarnessHome/);
  assert.match(posixInstaller, /npm prefix --global/);
  assert.match(windowsInstaller, /prefix --global/);
  assert.match(posixInstaller, /\.zprofile/);
  assert.match(windowsInstaller, /SetEnvironmentVariable\("Path"/);
  assert.ok(posixInstaller.indexOf("login --prepare-update") < posixInstaller.indexOf("npm install --global"));
  assert.ok(windowsInstaller.indexOf("login --prepare-update") < windowsInstaller.indexOf("install --global"));
  assert.match(windowsInstaller, /Test-FullyQualifiedWindowsPath/);
  assert.match(windowsInstaller, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,63\}\$/);
  assert.match(windowsInstaller, /Profile\.ToLowerInvariant\(\).*"logs"/s);
});

test("Linux installer resolves npm global bin, persists PATH, and invokes login", async t => {
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
    uname: "#!/bin/sh\nprintf 'Linux\\n'\n",
    node: "#!/bin/sh\nprintf '24\\n'\n",
    npm: `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_NPM_LOG"
if [ "$1" = "prefix" ]; then printf '%s\\n' "$FAKE_NPM_PREFIX"; fi
if [ "$1" = "install" ] && [ "\${FAKE_NPM_FAIL:-0}" = "1" ]; then exit 9; fi
`,
    "octo-harness": `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "--help" ]; then
  printf '%s\\n' 'login --enroll-token-stdin --prepare-update --recover-update'
  exit 0
fi
case " $* " in
  *" login --prepare-update --wait-drained "*)
    printf 'PREPARE %s\\n' "$*" > "$FAKE_SETUP_LOG"
    exit 0
    ;;
  *" login --recover-update --start "*)
    printf 'RECOVER %s\\n' "$*" >> "$FAKE_SETUP_LOG"
    exit 0
    ;;
  *" daemon install "*)
    printf 'INSTALL %s\\n' "$*" >> "$FAKE_SETUP_LOG"
    exit 0
    ;;
  *" daemon start --wait-online "*)
    printf 'START %s\\n' "$*" >> "$FAKE_SETUP_LOG"
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
  await execute("sh", [posixInstallerPath, "https://server.example", "octo_enroll_test"], {
    env: installerEnvironment
  });

  assert.match(await readFile(npmLog, "utf8"), /install --global --no-audit --no-fund @mininglamp-oss\/octo-harness@latest/);
  const setupInvocation = await readFile(setupLog, "utf8");
  assert.match(setupInvocation, /PREPARE .*login --prepare-update --wait-drained/);
  assert.match(setupInvocation, new RegExp(`LOGIN --home ${harnessHome.replaceAll("/", "\\/")} --profile default login`));
  assert.match(setupInvocation, /--enroll-token-stdin/);
  assert.match(setupInvocation, /INSTALL .*daemon install/);
  assert.match(setupInvocation, /START .*daemon start --wait-online/);
  assert.doesNotMatch(setupInvocation, /--install-service|--no-install-service/);
  assert.match(setupInvocation, /octo_enroll_test/);
  const identityPath = join(harnessHome, "identity/runtime.json");
  await mkdir(join(harnessHome, "identity"), { recursive: true });
  await writeFile(identityPath, '{"schema_version":1,"runtime_key":"runtime-existing"}\n', "utf8");
  await execute("sh", [posixInstallerPath, "https://server.example"], { env: installerEnvironment });
  assert.match(await readFile(setupLog, "utf8"), /LOGIN .*--enroll-token-stdin\n\nINSTALL .*daemon install\nSTART .*daemon start --wait-online\n$/);

  await assert.rejects(
    execute("sh", [posixInstallerPath, "https://server.example"], {
      env: { ...installerEnvironment, FAKE_LOGIN_FAIL: "1" }
    }),
    error => error.code === 2 && /Restored the service after the updated login failed/.test(error.stdout)
  );
  assert.match(await readFile(setupLog, "utf8"), /RECOVER .*login --recover-update --start/);
  assert.match(await readFile(join(userHome, ".zprofile"), "utf8"), new RegExp(npmPrefix.replaceAll("/", "\\/")));

  await assert.rejects(
    execute("sh", [posixInstallerPath, "https://server.example", "octo_enroll_test"], {
      env: { ...installerEnvironment, FAKE_NPM_FAIL: "1" }
    }),
    error => error.code === 9 && /Restored the previous service/.test(error.stdout)
  );
  assert.match(await readFile(setupLog, "utf8"), /RECOVER .*login --recover-update --start/);
});

test("installers attempt service recovery when npm update fails after drain", async () => {
  const [posixInstaller, windowsInstaller] = await Promise.all([
    readFile(posixInstallerPath, "utf8"),
    readFile(windowsInstallerPath, "utf8")
  ]);

  for (const source of [posixInstaller, windowsInstaller]) {
    assert.match(source, /login --recover-update/);
    assert.ok(source.indexOf("login --prepare-update") < source.indexOf("install --global"));
    assert.ok(source.indexOf("install --global") < source.lastIndexOf("login --recover-update"));
  }
});

test("root README publishes POSIX and Windows one-line commands", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  assert.match(readme, /install\.sh[\s\\]+\| sh -s --/);
  assert.match(readme, /\[scriptblock\]::Create\(\(irm .*install\.ps1\)\)/);
  assert.match(readme, /"https:\/\/im-test\.deepminer\.com\.cn"/);
  assert.match(readme, /"octo_enroll_REPLACE_WITH_ONE_TIME_TOKEN"/);
  assert.match(readme, /npm install -g/);
  assert.doesNotMatch(readme, /~\/\.local\/share\/octo-harness/);
});

test("published root package requires Node.js 24 and excludes compiler metadata", async () => {
  const [packageJson, tsconfig] = await Promise.all([
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(join(root, "tsconfig.base.json"), "utf8").then(JSON.parse)
  ]);
  assert.equal(packageJson.engines?.node, ">=24");
  assert.ok(packageJson.files.includes("apps/cli/README.md"));
  assert.ok(packageJson.files.includes("apps/cli/dist/**/*.js"));
  assert.ok(packageJson.files.includes("apps/daemon/dist/**/*.js"));
  assert.ok(packageJson.files.includes("apps/adapter-host/dist/**/*.js"));
  assert.ok(!packageJson.files.includes("apps/cli/dist"));
  assert.ok(!packageJson.files.includes("apps/daemon/dist"));
  assert.ok(!packageJson.files.includes("apps/adapter-host/dist"));
  assert.equal(tsconfig.compilerOptions.sourceMap, false);
  assert.equal(tsconfig.compilerOptions.declarationMap, false);
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
