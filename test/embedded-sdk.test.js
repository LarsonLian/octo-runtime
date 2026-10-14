import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RUNTIME_RUN_CONTRACT } from "../packages/octo-runtime-daemon/dist/index.js";
import { loadManagedAgentWorksFromRoot } from "../packages/octo-runtime-worker-access/dist/index.js";
import { createDaemonRuntime } from "../packages/octo-runtime-daemon/dist/runtime/index.js";
import {
  accountKeyFor,
  accountPaths,
  daemonHomePaths,
  ensureAccount,
  ensureDaemonHome,
  profileNameFor,
  profilePaths,
  readJson,
  resolveDaemonHome
} from "../packages/octo-runtime-daemon/dist/runtime/home.js";
import { ensureTenantEnrollment } from "../packages/octo-runtime-worker-access/dist/enrollment.js";

test("daemon Home keeps one machine identity across account roots", () => {
  const root = mkdtempSync(join(tmpdir(), "octo-embedded-home-"));
  try {
    const paths = daemonHomePaths(root);
    const first = ensureDaemonHome(paths);
    const second = ensureDaemonHome(paths);
    assert.equal(second.machine_id, first.machine_id);
    const accountA = accountPaths(paths, accountKeyFor("user", "user-a"));
    const accountB = accountPaths(paths, accountKeyFor("user", "user-b"));
    assert.notEqual(accountA.root, accountB.root);
    assert.equal(paths.machineFile, join(root, "machine.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows paths use LOCALAPPDATA and a Home-derived named pipe", () => {
  const home = resolveDaemonHome("customer-fde", {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Alice Zhang\\AppData\\Local" }
  });
  assert.equal(home, "C:\\Users\\Alice Zhang\\AppData\\Local\\customer-fde\\OctoRuntime");
  const paths = daemonHomePaths(home, "win32");
  assert.match(paths.socket, /^\\\\\.\\pipe\\octo-runtime-embedded-[0-9a-f]{16}$/);
  assert.throws(
    () => daemonHomePaths("\\\\server\\share\\octo", "win32"),
    (error) => error?.code === "HOME_UNSUPPORTED"
  );
});

test("Human Token enrollment persists a loadable account-scoped profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "octo-embedded-enroll-"));
  try {
    const paths = daemonHomePaths(root);
    const machine = ensureDaemonHome(paths);
    const account = accountPaths(paths, accountKeyFor("user", "uid-123"));
    const profileName = profileNameFor("octo-work", "space-1");
    ensureAccount(account, [profileName]);
    const profile = profilePaths(account, profileName);
    const calls = [];
    let rejectRegistration = false;
    const fetchImplementation = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/runtime_enrollments")) {
        return Response.json({
          enrollment_token: "octo_enroll_test",
          octo_space_id: "space-1",
          owner_subject_type: "user",
          owner_subject_id: "uid-123"
        });
      }
      if (String(url).endsWith("/v1/runtimes/enroll")) {
        return Response.json(
          {
            runtime: {
              runtime_id: JSON.parse(init.body).runtime_id,
              profile: profileName,
              octo_space_id: "space-1",
              owner_subject_type: "user",
              owner_subject_id: "uid-123"
            },
            credential: { runtime_credential_id: "credential-1", token: "octo_runtime_secret" }
          },
          { status: 201 }
        );
      }
      assert.ok(String(url).endsWith("/v1/runtime/register"));
      const registration = JSON.parse(init.body);
      assert.equal(Object.hasOwn(registration, "agent_identity"), false);
      assert.equal(Object.hasOwn(registration, "agent_name"), false);
      assert.deepEqual(registration.capabilities, {
        run_contract: RUNTIME_RUN_CONTRACT,
        adapters: []
      });
      if (rejectRegistration)
        return Response.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              details: { reason_code: "RUNTIME_RUN_CONTRACT_UNSUPPORTED" }
            }
          },
          { status: 400 }
        );
      return Response.json({
        runtime: {
          runtime_id: readJson(profile.identityFile).runtime_id,
          profile: profileName,
          protocol_version: 2
        }
      });
    };
    const result = await ensureTenantEnrollment({
      subject: { type: "user", id: "uid-123" },
      tenant: {
        id: "space-1",
        serverUrl: "https://im-test.deepminer.com.cn",
        agentWorkUrl: "https://im-test.deepminer.com.cn/agentworker/api",
        businessServiceBindings: {
          task: { serviceSubjectId: "loop", url: "https://local-config.test/mcp/task" }
        }
      },
      profile,
      machine,
      getHumanToken: () => "human-token",
      fetchImplementation,
      signal: new AbortController().signal
    });
    assert.equal(result.runtimeId, readJson(profile.identityFile).runtime_id);
    assert.match(result.runtimeId, /^runtime_[a-f0-9-]+$/);
    assert.equal(calls[0].init.headers.Token, "human-token");
    assert.equal(calls[0].init.headers["X-Space-ID"], "space-1");
    const credential = readJson(profile.credentialFile);
    assert.equal(credential.access_token, "octo_runtime_secret");
    const runtimes = loadManagedAgentWorksFromRoot(account.root, [profileName]);
    assert.equal(runtimes.length, 1);
    assert.equal(runtimes[0].runtimeId, result.runtimeId);
    assert.equal(runtimes[0].profile, profileName);
    assert.deepEqual(runtimes[0].businessServiceBindings, {
      task: { serviceSubjectId: "loop", url: "https://local-config.test/mcp/task" }
    });
    assert.equal(
      calls.some((call) => String(call.init.body).includes("local-config.test")),
      false
    );
    calls.length = 0;
    const reused = await ensureTenantEnrollment({
      subject: { type: "user", id: "uid-123" },
      tenant: {
        id: "space-1",
        serverUrl: "https://im-test.deepminer.com.cn",
        agentWorkUrl: "https://im-test.deepminer.com.cn/agentworker/api"
      },
      profile,
      machine,
      getHumanToken: () => {
        throw new Error("saved credentials must not trigger re-enrollment");
      },
      fetchImplementation,
      signal: new AbortController().signal
    });
    assert.equal(reused.reused, true);
    assert.deepEqual(
      loadManagedAgentWorksFromRoot(account.root, [profileName])[0].businessServiceBindings,
      {}
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(
      JSON.parse(calls[0].init.body).capabilities.run_contract,
      RUNTIME_RUN_CONTRACT
    );
    calls.length = 0;
    rejectRegistration = true;
    await assert.rejects(
      ensureTenantEnrollment({
        subject: { type: "user", id: "uid-123" },
        tenant: {
          id: "space-1",
          serverUrl: "https://im-test.deepminer.com.cn",
          agentWorkUrl: "https://im-test.deepminer.com.cn/agentworker/api"
        },
        profile,
        machine,
        getHumanToken: () => {
          throw new Error("contract failure must not replace credentials");
        },
        fetchImplementation,
        signal: new AbortController().signal
      }),
      /400 VALIDATION_ERROR\/RUNTIME_RUN_CONTRACT_UNSUPPORTED/
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(readJson(profile.credentialFile), credential);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "daemon SDK starts locally without registration and reuses local identities after restart",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "oe-"));
    const harness = createDaemonRuntime({
      appId: "sdk-smoke",
      home: root,
      development: true,
      startupTimeoutMs: 15_000
    });
    try {
      const health = await harness.startAccount({
        subject: { type: "user", id: "uid-smoke" },
        tenants: ["space-1", "space-2"].map((id) => ({ id }))
      });
      assert.equal(health.local.ready, true);
      assert.equal(health.profiles.length, 2);
      const ids = health.profiles.map((profile) => profile.runtimeId).sort();
      assert.equal(new Set(ids).size, 2);
      ids.forEach((id) => assert.match(id, /^runtime_[a-f0-9-]+$/));
      assert.equal(health.phase, "running");
      assert.deepEqual(health.modules, {});
      await harness.stop("quit");
      const restarted = await harness.startAccount({
        subject: { type: "user", id: "uid-smoke" },
        tenants: [{ id: "space-1" }, { id: "space-2" }]
      });
      assert.equal(restarted.local.ready, true);
      assert.deepEqual(restarted.profiles.map((profile) => profile.runtimeId).sort(), ids);
      await harness.stop("quit");
      assert.equal(harness.health().phase, "stopped");
    } catch (error) {
      const logPath = join(
        root,
        "accounts",
        accountKeyFor("user", "uid-smoke"),
        "logs",
        "embedded-runtime.log"
      );
      if (existsSync(logPath)) console.error(readFileSync(logPath, "utf8"));
      throw error;
    } finally {
      await harness.stop("quit").catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test("daemon runtime preserves proxy routing and debug logging without unrelated credentials", async () => {
  const { childEnvironment } =
    await import("../packages/octo-runtime-daemon/dist/runtime/supervisor.js");
  const values = {
    OCTO_RUNTIME_DEBUG: "1",
    NO_PROXY: "localhost,127.0.0.1",
    https_proxy: "http://proxy.example:8080",
    OCTO_TEST_PRIVATE_TOKEN: "not-inherited"
  };
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    const env = childEnvironment({ home: "/tmp/harness" });
    assert.equal(env.OCTO_RUNTIME_DEBUG, "1");
    assert.equal(env.OCTO_RUNTIME_LOG_DIR, undefined);
    assert.equal(env.NO_PROXY, values.NO_PROXY);
    assert.equal(env.https_proxy, values.https_proxy);
    assert.equal(env.OCTO_TEST_PRIVATE_TOKEN, undefined);
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
