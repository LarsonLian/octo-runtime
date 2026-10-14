import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import { runCli } from "../apps/cli/dist/main.js";
import { enrollRuntime } from "../apps/cli/dist/enrollment.js";

async function assertAbsent(path) {
  await assert.rejects(access(path), error => error.code === "ENOENT");
}

test("failed enrollment leaves no pending or profile identity state", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-enrollment-state-"));
  const profile = "space-user";
  try {
    await assert.rejects(
      runCli([
        "--home", home,
        "--profile", profile,
        "login",
        "--server-url", "https://im-test.deepminer.com.cn",
        "--enroll-token-stdin"
      ], {
        input: Readable.from(["octo_enroll_invalid\n"]),
        fetchImplementation: async () => new Response(JSON.stringify({
          error: { code: "ENROLLMENT_INVALID", message: "invalid enrollment" }
        }), { status: 401, headers: { "Content-Type": "application/json", "X-Request-Id": "req-worker-rejected" } })
      }),
      /ENROLLMENT_INVALID.*request_id=req-worker-rejected/
    );

    await assertAbsent(join(home, profile, "setup", "pending-enrollment.json"));
    await assertAbsent(join(home, profile, "identity", "runtime.json"));
    await assertAbsent(join(home, profile, "credentials", "runtime-token.json"));
    await assertAbsent(join(home, profile, "config.json"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("registration failure preserves the enrolled identity for a credential-proven retry", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-enrollment-register-retry-"));
  const args = [
    "--home", home,
    "--profile", "default",
    "login",
    "--server-url", "https://im-test.deepminer.com.cn",
    "--enroll-token-stdin"
  ];
  let enrollmentCount = 0;
  let registrationCount = 0;
  const fetchImplementation = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/runtimes/enroll")) {
      enrollmentCount++;
      const body = JSON.parse(init.body);
      if (enrollmentCount === 1) {
        assert.equal(body.runtime_id, undefined);
        assert.equal(init.headers["X-Runtime-Token"], undefined);
      } else {
        assert.equal(body.runtime_id, "runtime_original");
        assert.equal(init.headers["X-Runtime-Token"], "runtime_token_1");
      }
      return Response.json({
        runtime: { runtime_id: "runtime_original", profile: "default", octo_space_id: "space_fixture" , protocol_version: 2 },
        credential: { runtime_credential_id: `credential_${enrollmentCount}`, token: `runtime_token_${enrollmentCount}` }
      });
    }
    if (url.endsWith("/v1/runtime/register")) {
      registrationCount++;
      assert.deepEqual(JSON.parse(init.body).capabilities.run_contract, { schema_version: 7, context_schema: "octo.context-envelope/v3", approval_schema: "octo.approval-request/v1", routing_schema: "octo.runtime-selection/v2" });
      if (registrationCount === 1) {
        return Response.json({ error: { code: "UNAVAILABLE", message: "worker restarting" } }, { status: 503 });
      }
      assert.equal(init.headers.Authorization, "Bearer runtime_token_2");
      return Response.json({ runtime: { runtime_id: "runtime_original", profile: "default" , protocol_version: 2 } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    await assert.rejects(runCli(args, {
      input: Readable.from(["octo_enroll_first\n"]), output: () => undefined, fetchImplementation
    }), /Runtime registration failed/);

    const identityAfterFailure = JSON.parse(await readFile(join(home, "default/identity/runtime.json"), "utf8"));
    const credentialAfterFailure = JSON.parse(await readFile(join(home, "default/credentials/runtime-token.json"), "utf8"));
    assert.equal(identityAfterFailure.runtime_id, "runtime_original");
    assert.equal(identityAfterFailure.credential_id, "credential_1");
    assert.equal(credentialAfterFailure.access_token, "runtime_token_1");

    await runCli(args, {
      input: Readable.from(["octo_enroll_second\n"]), output: () => undefined, fetchImplementation
    });

    const identityAfterRetry = JSON.parse(await readFile(join(home, "default/identity/runtime.json"), "utf8"));
    assert.equal(identityAfterRetry.runtime_id, "runtime_original");
    assert.equal(identityAfterRetry.credential_id, "credential_2");
    assert.equal(enrollmentCount, 2);
    assert.equal(registrationCount, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenClaw connect saves a Runtime connection without binding or configuring an Agent", async t => {
  const home = await mkdtemp(join(tmpdir(), "oh-openclaw-config-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  const calledMethods = [];
  const rotatedGatewayToken = "rotated-device-token";
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture-nonce", ts: Date.now() } }));
    socket.on("message", data => {
      const frame = JSON.parse(Buffer.from(data).toString("utf8"));
      calledMethods.push(frame.method);
      let payload;
      if (frame.method === "connect") {
        payload = {
          type: "hello-ok",
          protocol: 4,
          features: {
            methods: ["sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort", "agents.list"],
            events: ["agent"]
          },
          auth: { deviceToken: rotatedGatewayToken }
        };
      } else if (frame.method === "agents.list") payload = { agents: [{ id: "openclaw-external-agent", workspace: "/srv/openclaw-agent" }] };
      else {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: `unexpected method ${frame.method}` } }));
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  const enrollmentFetch = async (input, init) => {
    if (String(input).endsWith("/v1/runtimes/enroll")) {
      return Response.json({
        data: {
          runtime: {
            runtime_id: "runtime_fixture",
            profile: "default",
            octo_space_id: "space_fixture",
            owner_subject_type: "user",
            owner_subject_id: "user_fixture",
            created_by_octo_uid: "user_fixture"
          },
          credential: { runtime_credential_id: "credential_fixture", token: "runtime-token" }
        }
      });
    }
    assert.equal(String(input), "https://im-test.deepminer.com.cn/agentworker/api/v1/runtime/register");
    assert.equal(JSON.parse(init.body).profile, "default");
    return Response.json({ data: { runtime: { runtime_id: "runtime_fixture", profile: "default" , protocol_version: 2 } } });
  };
  try {
    await runCli([
      "--home", home,
      "login",
      "--server-url", "https://im-test.deepminer.com.cn",
      "--enroll-token-stdin"
    ], {
      input: Readable.from(["octo_enroll_fixture\n"]), output: () => undefined,
      fetchImplementation: enrollmentFetch
    });
    const externalOutput = [];
    await runCli([
      "--home", home, "--profile", "default", "adapter", "connect", "openclaw",
      "--gateway-url", `ws://127.0.0.1:${address.port}`,
      "--token-stdin"
    ], { input: Readable.from(["gateway-token\n"]), output: value => externalOutput.push(JSON.parse(value)) });
    assert.equal(externalOutput[0].source, "gateway");
    assert.equal(externalOutput[0].available, true);
    const externalProfile = JSON.parse(await readFile(join(home, "default/config.json"), "utf8"));
    assert.equal(externalProfile.adapters, undefined);
    const connection = JSON.parse(await readFile(join(home, "default/adapters/openclaw/connection.json"), "utf8"));
    assert.equal(connection.source, "gateway");
    assert.equal(connection.agent_id, undefined);
    assert.deepEqual(calledMethods.slice(-2), ["connect", "agents.list"]);
    assert.equal(JSON.stringify(connection).includes("gateway-token"), false);
    const credential = JSON.parse(await readFile(join(home, "default", connection.credential_ref), "utf8"));
    assert.equal(credential.access_token, "gateway-token");

  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("re-enrollment reuses the Runtime and proves ownership with its credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-reenrollment-state-"));
  const profile = "space-user";
  const machineIds = [];
  let enrollmentCount = 0;
  const fetchImplementation = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/runtimes/enroll")) {
      enrollmentCount += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.profile, profile);
      machineIds.push(body.machine_id);
      assert.equal(body.runtime_id, enrollmentCount === 1 ? undefined : "runtime_fixture");
      assert.equal(init.headers["X-Runtime-Token"], enrollmentCount === 1 ? undefined : "runtime_token_1");
      return Response.json({
        data: {
          runtime: {
            profile,
            runtime_id: "runtime_fixture",
            octo_space_id: "space_fixture",
            owner_subject_type: "user",
            owner_subject_id: "user_fixture",
            created_by_octo_uid: "user_fixture"
          },
          credential: {
            runtime_credential_id: `credential_${enrollmentCount}`,
            token: `runtime_token_${enrollmentCount}`
          }
        }
      });
    }
    if (url.endsWith("/v1/runtime/register")) {
      assert.equal(JSON.parse(init.body).profile, profile);
      return Response.json({ data: { runtime: { profile, runtime_id: "runtime_fixture" , protocol_version: 2 } } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const args = [
      "--home", home,
      "--profile", profile,
      "login",
      "--server-url", "https://im-test.deepminer.com.cn",
      "--enroll-token-stdin"
    ];
    await runCli(args, {
      input: Readable.from(["octo_enroll_first\n"]),
      output: () => undefined,
      fetchImplementation
    });
    const firstIdentity = JSON.parse(await readFile(join(home, profile, "identity", "runtime.json"), "utf8"));

    await runCli(args, {
      input: Readable.from(["octo_enroll_second\n"]),
      output: () => undefined,
      fetchImplementation
    });
    const secondIdentity = JSON.parse(await readFile(join(home, profile, "identity", "runtime.json"), "utf8"));

    assert.equal(enrollmentCount, 2);
    assert.equal(machineIds.length, 2);
    assert.equal(machineIds[0], machineIds[1]);
    assert.equal("system_id" in secondIdentity, false);
    assert.equal("device_id" in secondIdentity, false);
    assert.equal("owner_subject_type" in secondIdentity, false);
    assert.equal("owner_subject_id" in secondIdentity, false);
    assert.equal("created_by_octo_uid" in secondIdentity, false);
    assert.equal(secondIdentity.profile, profile);
    const configuration = JSON.parse(await readFile(join(home, profile, "config.json"), "utf8"));
    assert.equal(configuration.agent_work_url, "https://im-test.deepminer.com.cn/agentworker/api");
    assert.equal(configuration.octo_space_id, "space_fixture");
    assert.equal("owner_subject_type" in configuration, false);
    assert.equal("owner_subject_id" in configuration, false);
    assert.equal("created_by_octo_uid" in configuration, false);
    assert.equal("tenant_id" in configuration, false);
    assert.equal("subject_id" in configuration, false);
    const machine = JSON.parse(await readFile(join(home, "machine.json"), "utf8"));
    assert.equal(machine.machine_id, machineIds[0]);
    assert.equal(secondIdentity.runtime_id, firstIdentity.runtime_id);
    assert.equal(secondIdentity.credential_id, "credential_2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a fresh enrollment token updates the endpoint while preserving the existing Runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-reenrollment-rebind-"));
  const profile = "default";
  let enrollmentCount = 0;
  const machineIds = [];
  const fetchImplementation = async (input, init) => {
    const url = String(input);
    const isEnrollment = url.endsWith("/v1/runtimes/enroll");
    if (isEnrollment) {
      enrollmentCount++;
      const body = JSON.parse(init.body);
      machineIds.push(body.machine_id);
      assert.equal(body.runtime_id, enrollmentCount === 1 ? undefined : "runtime_original");
      assert.equal(init.headers["X-Runtime-Token"], enrollmentCount === 1 ? undefined : "runtime_token_old");
      const expectedBase = enrollmentCount === 1 ? "http://localhost:8091" : "http://localhost:3000";
      assert.equal(url, `${expectedBase}/agentworker/api/v1/runtimes/enroll`);
      return Response.json({
        runtime: {
          runtime_id: "runtime_original",
          profile,
          octo_space_id: "space_fixture"
        },
        credential: {
          runtime_credential_id: enrollmentCount === 1 ? "credential_old" : "credential_new",
          token: enrollmentCount === 1 ? "runtime_token_old" : "runtime_token_new"
        }
      });
    }
    if (url.endsWith("/v1/runtime/register")) {
      const expectedBase = enrollmentCount === 1 ? "http://localhost:8091" : "http://localhost:3000";
      assert.equal(url, `${expectedBase}/agentworker/api/v1/runtime/register`);
      return Response.json({ runtime: { runtime_id: "runtime_original", profile , protocol_version: 2 } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const common = ["--home", home, "--profile", profile, "login"];
    await runCli([...common, "--server-url", "http://localhost:8091", "--enroll-token-stdin"], {
      input: Readable.from(["octo_enroll_old\n"]), output: () => undefined, fetchImplementation
    });
    await runCli([...common, "--server-url", "http://localhost:3000", "--enroll-token-stdin"], {
      input: Readable.from(["octo_enroll_new\n"]), output: () => undefined, fetchImplementation
    });

    const identity = JSON.parse(await readFile(join(home, profile, "identity/runtime.json"), "utf8"));
    const configuration = JSON.parse(await readFile(join(home, profile, "config.json"), "utf8"));
    const credential = JSON.parse(await readFile(join(home, profile, "credentials/runtime-token.json"), "utf8"));
    assert.equal(identity.runtime_id, "runtime_original");
    assert.equal(identity.credential_id, "credential_new");
    assert.equal(credential.access_token, "runtime_token_new");
    assert.equal(configuration.server_url, "http://localhost:3000");
    assert.equal(configuration.agent_work_url, "http://localhost:3000/agentworker/api");
    assert.equal(machineIds[0], machineIds[1]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a fresh enrollment replaces stale local Runtime state after the Worker loses it", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-reenrollment-stale-runtime-"));
  const profile = "default";
  let enrollmentCalls = 0;
  const enrollmentTokens = [];
  const fetchImplementation = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/runtimes/enroll")) {
      enrollmentCalls++;
      const body = JSON.parse(init.body);
      enrollmentTokens.push(init.headers.Authorization);
      if (enrollmentCalls === 1) {
        assert.equal(body.runtime_id, undefined);
        return Response.json({
          runtime: { runtime_id: "runtime_stale", profile, octo_space_id: "space_fixture" , protocol_version: 2 },
          credential: { runtime_credential_id: "credential_stale", token: "runtime_token_stale" }
        });
      }
      if (enrollmentCalls === 2) {
        assert.equal(body.runtime_id, "runtime_stale");
        assert.equal(init.headers["X-Runtime-Token"], "runtime_token_stale");
        return Response.json({
          error: {
            code: "AUTH_REQUIRED",
            message: "invalid or expired runtime enrollment",
            details: { reason_code: "ENROLLMENT_INVALID" }
          }
        }, { status: 401 });
      }
      assert.equal(body.runtime_id, undefined);
      assert.equal(init.headers["X-Runtime-Token"], undefined);
      return Response.json({
        runtime: { runtime_id: "runtime_recovered", profile, octo_space_id: "space_fixture" , protocol_version: 2 },
        credential: { runtime_credential_id: "credential_recovered", token: "runtime_token_recovered" }
      });
    }
    if (url.endsWith("/v1/runtime/register")) {
      const expectedRuntime = enrollmentCalls === 1 ? "runtime_stale" : "runtime_recovered";
      return Response.json({ runtime: { runtime_id: expectedRuntime, profile , protocol_version: 2 } });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  try {
    const common = ["--home", home, "--profile", profile, "login", "--server-url", "http://localhost:8091", "--enroll-token-stdin"];
    await runCli(common, {
      input: Readable.from(["octo_enroll_initial\n"]), output: () => undefined, fetchImplementation
    });
    await runCli(common, {
      input: Readable.from(["octo_enroll_fresh\n"]), output: () => undefined, fetchImplementation
    });

    const identity = JSON.parse(await readFile(join(home, profile, "identity/runtime.json"), "utf8"));
    const credential = JSON.parse(await readFile(join(home, profile, "credentials/runtime-token.json"), "utf8"));
    assert.equal(identity.runtime_id, "runtime_recovered");
    assert.equal(identity.credential_id, "credential_recovered");
    assert.equal(credential.access_token, "runtime_token_recovered");
    assert.deepEqual(enrollmentTokens, [
      "Bearer octo_enroll_initial",
      "Bearer octo_enroll_fresh",
      "Bearer octo_enroll_fresh"
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit Agent Worker API root appends only native /v1 routes", async () => {
  const urls = [];
  const requestIds = [];
  await enrollRuntime({
    serverUrl: "http://localhost:3000",
    agentWorkUrl: "http://127.0.0.1:8092",
    enrollmentToken: "octo_enroll_fixture",
    profile: "default",
    runtimeName: "MacBook",
    machineId: "machine_fixture",
    fetchImplementation: async (input, init) => {
      urls.push(String(input));
      requestIds.push(init.headers["X-Request-Id"]);
      if (urls.length === 1) {
        return Response.json({
          runtime: {
            runtime_id: "runtime_fixture",
            profile: "default",
            octo_space_id: "space_fixture",
            owner_subject_type: "user",
            owner_subject_id: "user_fixture",
            created_by_octo_uid: "user_fixture"
          },
          credential: { runtime_credential_id: "credential_fixture", token: "octo_runtime_fixture" }
        });
      }
      return Response.json({ runtime: { runtime_id: "runtime_fixture", profile: "default" , protocol_version: 2 } });
    }
  });

  assert.deepEqual(urls, [
    "http://127.0.0.1:8092/v1/runtimes/enroll",
    "http://127.0.0.1:8092/v1/runtime/register"
  ]);
  assert.equal(new Set(requestIds).size, 2);
  assert.ok(requestIds.every(requestId => /^req_[0-9a-f]{32}$/.test(requestId)));
});

test("invalid machine state is rejected without overwriting it or enrolling", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-invalid-machine-"));
  try {
    for (const invalid of ["{invalid json", "null", "false", "0", JSON.stringify({ schema_version: 2, machine_id: "machine_invalid" }),
      JSON.stringify({ schema_version: 1, machine_id: "forged" })]) {
      await writeFile(join(home, "machine.json"), invalid);
      await assert.rejects(runCli(["--home", home, "login", "--server-url", "https://im-test.deepminer.com.cn", "--enroll-token-stdin"], {
        input: Readable.from(["octo_enroll_fixture\n"]), output: () => undefined,
        fetchImplementation: async () => { assert.fail("invalid machine state must not trigger enrollment"); }
      }));
      assert.equal(await readFile(join(home, "machine.json"), "utf8"), invalid);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("failed enrollment and process retry preserve the Home machine label", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-machine-retry-"));
  const machineIds = [];
  const args = ["--home", home, "login", "--server-url", "https://im-test.deepminer.com.cn", "--enroll-token-stdin"];
  try {
    const fetchImplementation = async (input, init) => {
      if (String(input).endsWith("/runtimes/enroll")) {
        machineIds.push(JSON.parse(init.body).machine_id);
        if (machineIds.length === 1) return Response.json({ error: { code: "UNAVAILABLE" } }, { status: 503 });
        return Response.json({ runtime: { profile: "default", runtime_id: "runtime_fixture", octo_space_id: "space_fixture" , protocol_version: 2 },
          credential: { runtime_credential_id: "credential_fixture", token: "runtime_token_fixture" } });
      }
      return Response.json({ runtime: { profile: "default", runtime_id: "runtime_fixture" , protocol_version: 2 } });
    };
    await assert.rejects(runCli(args, { input: Readable.from(["octo_enroll_fixture\n"]), output: () => undefined, fetchImplementation }));
    const before = await readFile(join(home, "machine.json"), "utf8");
    await runCli(args, { input: Readable.from(["octo_enroll_fixture\n"]), output: () => undefined, fetchImplementation });
    assert.equal(await readFile(join(home, "machine.json"), "utf8"), before);
    assert.equal(machineIds[0], machineIds[1]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("profiles share a machine label but have separate Runtime identities; ordinary login never enrolls", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-machine-profiles-"));
  const machineIds = [];
  let enrollmentCount = 0;
  const fetchImplementation = async (input, init) => {
    if (String(input).endsWith("/runtimes/enroll")) {
      enrollmentCount++;
      machineIds.push(JSON.parse(init.body).machine_id);
      return Response.json({ runtime: { profile: JSON.parse(init.body).profile, runtime_id: `runtime_${enrollmentCount}`, octo_space_id: "space_fixture" },
        credential: { runtime_credential_id: `credential_${enrollmentCount}`, token: `runtime_token_${enrollmentCount}` } });
    }
    return Response.json({ runtime: { profile: JSON.parse(init.body).profile, runtime_id: `runtime_${enrollmentCount}` } });
  };
  try {
    for (const profile of ["default", "work"]) {
      const args = ["--home", home, "--profile", profile, "login"];
      await runCli([...args, "--server-url", "https://im-test.deepminer.com.cn", "--enroll-token-stdin"], {
        input: Readable.from([`octo_enroll_${profile}\n`]), output: () => undefined, fetchImplementation
      });
      for (let i = 0; i < 20; i++) await runCli(args, { output: () => undefined, fetchImplementation });
    }
    assert.equal(enrollmentCount, 2);
    assert.equal(machineIds[0], machineIds[1]);
    const identities = await Promise.all(["default", "work"].map(async profile =>
      JSON.parse(await readFile(join(home, profile, "identity/runtime.json"), "utf8"))));
    assert.notEqual(identities[0].runtime_id, identities[1].runtime_id);
    assert.deepEqual(identities.map(identity => identity.profile), ["default", "work"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("enrollment and registration require the exact returned profile", async () => {
  for (const stage of ["enroll", "register"]) {
    for (const returnedProfile of [undefined, "Work", "other", "work "]) {
      let calls = 0;
      await assert.rejects(enrollRuntime({
        serverUrl: "http://localhost:3000", enrollmentToken: "octo_enroll_fixture",
        profile: "work", runtimeName: "MacBook", machineId: "machine_fixture",
        fetchImplementation: async (_input, init) => {
          calls++;
          assert.equal(JSON.parse(init.body).profile, "work");
          return Response.json({
            runtime: {
              runtime_id: "runtime_fixture", profile: (calls === 1 ? stage === "enroll" : stage === "register") ? returnedProfile : "work",
              octo_space_id: "space_fixture"
            }, credential: { runtime_credential_id: "credential_fixture", token: "octo_runtime_fixture" }
          });
        }
      }), /profile/);
      assert.equal(calls, stage === "enroll" ? 1 : 2);
    }
  }
});

test("login persists a 128-character profile and rejects missing or mismatched identity profiles", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-long-profile-"));
  const profile = "a".repeat(128);
  const args = ["--home", home, "--profile", profile, "login"];
  try {
    await runCli([...args, "--server-url", "http://localhost:3000", "--enroll-token-stdin"], {
      input: Readable.from(["octo_enroll_fixture\n"]), output: () => undefined,
      fetchImplementation: async (_input, init) => {
        assert.equal(JSON.parse(init.body).profile, profile);
        return Response.json({ runtime: { runtime_id: "runtime_fixture", profile, octo_space_id: "space_fixture" , protocol_version: 2 },
          credential: { runtime_credential_id: "credential_fixture", token: "octo_runtime_fixture" } });
      }
    });
    const path = join(home, profile, "identity/runtime.json");
    const identity = JSON.parse(await readFile(path, "utf8"));
    assert.equal(identity.profile, profile);
    for (const wrong of [undefined, "other"]) {
      await writeFile(path, JSON.stringify({ ...identity, profile: wrong }));
      await assert.rejects(runCli(args, {
        output: () => undefined,
        fetchImplementation: async () => assert.fail("invalid identity must not trigger enrollment")
      }), /runtime identity is invalid/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Agent identity and display name survive CLI registration, profile loading and repeated login", async () => {
  const { loadManagedAgentWorks } = await import("../packages/octo-runtime-worker-access/dist/managed-profile.js");
  const home = await mkdtemp(join(tmpdir(), "oh-agent-identity-"));
  const registrations = [];
  const fetchImplementation = async (input, init) => {
    if (String(input).endsWith("/v1/runtimes/enroll")) return Response.json({
      runtime: { runtime_id: "runtime_identity", profile: "default", octo_space_id: "space" },
      credential: { runtime_credential_id: "credential", token: "test_runtime_credential" }
    });
    if (String(input).endsWith("/v1/runtime/register")) {
      registrations.push(JSON.parse(init.body));
      return Response.json({ runtime: { runtime_id: "runtime_identity", profile: "default" }, agent: { agent_id: "agent_identity", identity: "bot_123" } });
    }
    throw new Error("unexpected endpoint");
  };
  const common = ["--home", home, "--profile", "default", "login"];
  try {
    await runCli([...common, "--server-url=https://im-test.deepminer.com.cn", "--enroll-token-stdin", "--agent-identit=bot_123", "--agent_name=云端分身"], {
      input: Readable.from(["octo_enroll_identity_test\n"]), output: () => {}, fetchImplementation
    });
    assert.equal(registrations[0].agent_identity, "bot_123");
    assert.equal(registrations[0].agent_name, "云端分身");
    let profile = loadManagedAgentWorks(home)[0];
    assert.equal(profile.agentIdentity, "bot_123");
    assert.equal(profile.agentName, "云端分身");
    await runCli([...common, "--agent-name", "第二次注册名称"], { output: () => {}, fetchImplementation });
    assert.equal(registrations[1].agent_identity, "bot_123");
    profile = loadManagedAgentWorks(home)[0];
    assert.equal(profile.agentIdentity, "bot_123");
    assert.equal(profile.agentName, "第二次注册名称");
    await assert.rejects(runCli([...common, "--agent-identit=a", "--agent-identity=b"], { output: () => {} }), /duplicate/);
    await assert.rejects(runCli([...common, "--agent-identity="], { output: () => {} }), /nonempty/);
    await assert.rejects(runCli([...common, "--agent-identity=bad identity"], { output: () => {} }), /invalid/);
    assert.equal(registrations.length, 2);
  } finally { await rm(home, { recursive: true, force: true }); }
});
