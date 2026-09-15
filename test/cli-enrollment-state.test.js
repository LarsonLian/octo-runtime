import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runCli } from "../apps/cli/dist/main.js";

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

test("re-enrollment reuses the Runtime and proves ownership with its credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-reenrollment-state-"));
  const profile = "space-user";
  const machineIds = [];
  let enrollmentCount = 0;
  const fetchImplementation = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/runtimes/enroll")) {
      enrollmentCount += 1;
      const body = JSON.parse(String(init?.body));
      machineIds.push(body.machine_id);
      assert.equal(body.runtime_id, enrollmentCount === 1 ? undefined : "runtime_fixture");
      assert.equal(init.headers["X-Runtime-Token"], enrollmentCount === 1 ? undefined : "runtime_token_1");
      return Response.json({
        data: {
          runtime: {
            id: "runtime_fixture",
            octo_space_id: "space_fixture",
            owner_user_id: "user_fixture"
          },
          credential: {
            id: `credential_${enrollmentCount}`,
            token: `runtime_token_${enrollmentCount}`
          }
        }
      });
    }
    if (url.endsWith("/api/v1/runtime/register")) {
      return Response.json({ data: { runtime: { id: "runtime_fixture" } } });
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
        return Response.json({ runtime: { id: "runtime_fixture", octo_space_id: "space_fixture", owner_user_id: "user_fixture" },
          credential: { id: "credential_fixture", token: "runtime_token_fixture" } });
      }
      return Response.json({ runtime: { id: "runtime_fixture" } });
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
      return Response.json({ runtime: { id: `runtime_${enrollmentCount}`, octo_space_id: "space_fixture", owner_user_id: "user_fixture" },
        credential: { id: `credential_${enrollmentCount}`, token: `runtime_token_${enrollmentCount}` } });
    }
    return Response.json({ runtime: { id: `runtime_${enrollmentCount}` } });
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
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
