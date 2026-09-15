import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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

test("re-enrollment reuses the profile system identity and runtime", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-reenrollment-state-"));
  const profile = "space-user";
  const systemIds = [];
  let enrollmentCount = 0;
  const fetchImplementation = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/devices/enroll")) {
      enrollmentCount += 1;
      const body = JSON.parse(String(init?.body));
      systemIds.push(body.system_id);
      return Response.json({
        data: {
          device: {
            id: "device_fixture",
            octo_space_id: "space_fixture",
            owner_user_id: "user_fixture"
          },
          credential: {
            id: `credential_${enrollmentCount}`,
            token: `device_token_${enrollmentCount}`
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
    assert.equal(systemIds.length, 2);
    assert.equal(systemIds[0], systemIds[1]);
    assert.equal(secondIdentity.system_id, firstIdentity.system_id);
    assert.equal(secondIdentity.runtime_id, firstIdentity.runtime_id);
    assert.equal(secondIdentity.credential_id, "credential_2");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
