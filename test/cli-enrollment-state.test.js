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
        }), { status: 401, headers: { "Content-Type": "application/json" } })
      }),
      /ENROLLMENT_INVALID/
    );

    await assertAbsent(join(home, profile, "setup", "pending-enrollment.json"));
    await assertAbsent(join(home, profile, "identity", "runtime.json"));
    await assertAbsent(join(home, profile, "credentials", "runtime-token.json"));
    await assertAbsent(join(home, profile, "config.json"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("OpenClaw Gateway configuration requires login, stores secrets separately, and initializes an isolated runner", async t => {
  const home = await mkdtemp(join(tmpdir(), "oh-openclaw-config-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  assert.notEqual(typeof address, "string");
  let configPatch;
  let protocol = 4;
  const rotatedGatewayToken = "rotated-device-token";
  server.on("connection", socket => {
    socket.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "fixture-nonce", ts: Date.now() } }));
    socket.on("message", data => {
      const frame = JSON.parse(Buffer.from(data).toString("utf8"));
      let payload;
      if (frame.method === "connect") {
        payload = {
          type: "hello-ok",
          protocol,
          features: {
            methods: ["sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort", "agents.list", "agents.create", "config.get", "config.patch"],
            events: ["agent"]
          },
          auth: { deviceToken: rotatedGatewayToken }
        };
      } else if (frame.method === "agents.list") payload = { agents: [] };
      else if (frame.method === "agents.create") payload = { id: frame.params.name };
      else if (frame.method === "config.get") payload = { hash: "config-hash" };
      else if (frame.method === "config.patch") {
        configPatch = frame.params;
        payload = { ok: true };
      } else {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: `unexpected method ${frame.method}` } }));
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload }));
    });
  });
  const command = [
    "--home", home,
    "adapter", "openclaw", "configure",
    "--gateway-url", `ws://127.0.0.1:${address.port}`,
    "--token-stdin"
  ];
  const enrollmentFetch = async (input, init) => {
    if (String(input).endsWith("/v1/runtimes/enroll")) {
      return Response.json({
        data: {
          runtime: { id: "runtime_fixture", profile: "default", octo_space_id: "space_fixture", owner_ref: "uid:user_fixture" },
          credential: { id: "credential_fixture", token: "runtime-token" }
        }
      });
    }
    assert.equal(String(input), "https://im-test.deepminer.com.cn/agentworker/api/v1/runtime/register");
    assert.equal(JSON.parse(init.body).profile, "default");
    return Response.json({ data: { runtime: { id: "runtime_fixture", profile: "default" } } });
  };
  try {
    await assert.rejects(runCli(command, {
      input: Readable.from(["gateway-token\n"]), output: () => undefined
    }), /login first/);

    await runCli([
      "--home", home,
      "login",
      "--server-url", "https://im-test.deepminer.com.cn",
      "--enroll-token-stdin"
    ], {
      input: Readable.from(["octo_enroll_fixture\n"]), output: () => undefined,
      fetchImplementation: enrollmentFetch
    });
    await assert.rejects(
      runCli([...command, "--workspace", join(tmpdir(), "outside-openclaw-workspace")], {
        input: Readable.from(["gateway-token\n"]), output: () => undefined
      }),
      /runner workspace must stay under/
    );
    await assert.rejects(
      runCli([
        "--home", home, "adapter", "openclaw", "configure",
        "--gateway-url", "ws://gateway.example.test", "--workspace", "/srv/octo-runner", "--token-stdin"
      ], { input: Readable.from(["gateway-token\n"]), output: () => undefined }),
      /remote OpenClaw Gateway URLs must use wss/
    );
    await runCli(command, { input: Readable.from(["gateway-token\n"]), output: () => undefined });

    const profile = JSON.parse(await readFile(join(home, "default/config.json"), "utf8"));
    const credentialPath = join(home, "default/credentials/openclaw-gateway.json");
    const credential = JSON.parse(await readFile(credentialPath, "utf8"));
    assert.equal(profile.adapters.openclaw.gateway_url, `ws://127.0.0.1:${address.port}/`);
    assert.equal(profile.adapters.openclaw.agent_id, "octo-openclaw-runner");
    assert.equal(JSON.stringify(profile).includes("gateway-token"), false);
    assert.equal(credential.access_token, "gateway-token");
    assert.match(credential.device_id, /^[0-9a-f]{64}$/);
    assert.match(credential.private_key, /BEGIN PRIVATE KEY/);
    assert.equal(credential.provider_options.OPENCLAW_GATEWAY_TOKEN, "gateway-token");
    assert.equal(profile.adapters.openclaw.execution.provider_options.OPENCLAW_GATEWAY_URL, `ws://127.0.0.1:${address.port}/`);
    assert.equal(profile.adapters.openclaw.execution.credential_ref, "credentials/openclaw-gateway.json");
    assert.equal(JSON.stringify(profile.adapters.openclaw.execution).includes("gateway-token"), false);
    if (process.platform !== "win32") {
      const file = await import("node:fs/promises").then(module => module.stat(credentialPath));
      assert.equal(file.mode & 0o077, 0);
    }

    await runCli([
      "--home", home, "login", "--server-url", "https://im-test.deepminer.com.cn", "--enroll-token-stdin"
    ], {
      input: Readable.from(["octo_enroll_fixture_again\n"]), output: () => undefined,
      fetchImplementation: enrollmentFetch
    });
    const profileAfterRelogin = JSON.parse(await readFile(join(home, "default/config.json"), "utf8"));
    assert.deepEqual(profileAfterRelogin.adapters, profile.adapters);

    await runCli(["--home", home, "adapter", "openclaw", "init"], { output: () => undefined });
    const rotatedCredential = JSON.parse(await readFile(credentialPath, "utf8"));
    assert.equal(rotatedCredential.access_token, rotatedGatewayToken);
    assert.equal(rotatedCredential.provider_options.OPENCLAW_GATEWAY_TOKEN, rotatedGatewayToken);
    const patch = JSON.parse(configPatch.raw);
    assert.equal(patch.agents.defaults.skipBootstrap, true);
    assert.deepEqual(patch.agents.entries["octo-openclaw-runner"].skills, []);
    assert.equal(patch.agents.entries["octo-openclaw-runner"].contextInjection, "never");
    assert.deepEqual(patch.agents.entries["octo-openclaw-runner"].tools.deny, ["group:memory"]);
    assert.deepEqual(await readdir(profile.adapters.openclaw.workspace), []);
    if (process.platform !== "win32") {
      assert.equal((await stat(profile.adapters.openclaw.workspace)).mode & 0o222, 0);
    }
    protocol = 5;
    await assert.rejects(
      runCli(["--home", home, "adapter", "openclaw", "init"], { output: () => undefined }),
      /unsupported OpenClaw Gateway protocol/
    );
    if (process.platform !== "win32") {
      assert.equal((await stat(profile.adapters.openclaw.workspace)).mode & 0o222, 0);
    }
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
            id: "runtime_fixture",
            octo_space_id: "space_fixture",
            owner_ref: "uid:user_fixture"
          },
          credential: {
            id: `credential_${enrollmentCount}`,
            token: `runtime_token_${enrollmentCount}`
          }
        }
      });
    }
    if (url.endsWith("/v1/runtime/register")) {
      assert.equal(JSON.parse(init.body).profile, profile);
      return Response.json({ data: { runtime: { profile, id: "runtime_fixture" } } });
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
    assert.equal(secondIdentity.owner_ref, "uid:user_fixture");
    assert.equal(secondIdentity.profile, profile);
    const configuration = JSON.parse(await readFile(join(home, profile, "config.json"), "utf8"));
    assert.equal(configuration.agent_work_url, "https://im-test.deepminer.com.cn/agentworker/api");
    assert.equal(configuration.octo_space_id, "space_fixture");
    assert.equal(configuration.owner_ref, "uid:user_fixture");
    assert.equal("tenant_id" in configuration, false);
    assert.equal("subject_id" in configuration, false);
    const machine = JSON.parse(await readFile(join(home, "machine.json"), "utf8"));
    assert.equal(machine.machine_id, machineIds[0]);
    assert.equal(secondIdentity.runtime_id, firstIdentity.runtime_id);
    assert.equal(secondIdentity.credential_id, "credential_2");
    for (const flag of ["--server-url", "--agent-work-url"]) {
      await assert.rejects(runCli([...args, flag, "https://untrusted.example"], {
        input: Readable.from(["octo_enroll_third\n"]), output: () => undefined,
        fetchImplementation: async () => { assert.fail("must not send credentials to an untrusted endpoint"); }
      }), /trusted server and Agent Worker/);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("explicit Agent Worker API root appends only native /v1 routes", async () => {
  const urls = [];
  await enrollRuntime({
    serverUrl: "http://localhost:3000",
    agentWorkUrl: "http://127.0.0.1:8092",
    enrollmentToken: "octo_enroll_fixture",
    profile: "default",
    runtimeName: "MacBook",
    machineId: "machine_fixture",
    fetchImplementation: async input => {
      urls.push(String(input));
      if (urls.length === 1) {
        return Response.json({
          runtime: {
            id: "runtime_fixture",
            profile: "default",
            octo_space_id: "space_fixture",
            owner_ref: "uid:user_fixture"
          },
          credential: { id: "credential_fixture", token: "octo_runtime_fixture" }
        });
      }
      return Response.json({ runtime: { id: "runtime_fixture", profile: "default" } });
    }
  });

  assert.deepEqual(urls, [
    "http://127.0.0.1:8092/v1/runtimes/enroll",
    "http://127.0.0.1:8092/v1/runtime/register"
  ]);
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
        return Response.json({ runtime: { profile: "default", id: "runtime_fixture", octo_space_id: "space_fixture", owner_ref: "uid:user_fixture" },
          credential: { id: "credential_fixture", token: "runtime_token_fixture" } });
      }
      return Response.json({ runtime: { profile: "default", id: "runtime_fixture" } });
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
      return Response.json({ runtime: { profile: JSON.parse(init.body).profile, id: `runtime_${enrollmentCount}`, octo_space_id: "space_fixture", owner_ref: "uid:user_fixture" },
        credential: { id: `credential_${enrollmentCount}`, token: `runtime_token_${enrollmentCount}` } });
    }
    return Response.json({ runtime: { profile: JSON.parse(init.body).profile, id: `runtime_${enrollmentCount}` } });
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
              id: "runtime_fixture", profile: (calls === 1 ? stage === "enroll" : stage === "register") ? returnedProfile : "work",
              octo_space_id: "space_fixture", owner_ref: "uid:user_fixture"
            }, credential: { id: "credential_fixture", token: "octo_runtime_fixture" }
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
        return Response.json({ runtime: { id: "runtime_fixture", profile, octo_space_id: "space_fixture", owner_ref: "uid:user_fixture" },
          credential: { id: "credential_fixture", token: "octo_runtime_fixture" } });
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
