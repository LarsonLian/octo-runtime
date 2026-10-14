import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runtimePaths,
  assertProfileName,
  migrateLegacyProfileLayout,
  readJsonFile,
  reconcileHomeConfiguration
} from "../apps/cli/dist/state.js";

test("direct profile names cannot collide with Runtime Home infrastructure", () => {
  assert.doesNotThrow(() => assertProfileName("space-spade-user"));
  assert.throws(() => assertProfileName("logs"), /conflicts with Runtime Home infrastructure/);
  assert.throws(() => assertProfileName("STATE.DB"), /conflicts with Runtime Home infrastructure/);
});

test("profile labels accept exactly 1-128 characters", () => {
  for (const profile of ["a", "work.dev_1-2", "a".repeat(128)]) {
    assert.doesNotThrow(() => assertProfileName(profile));
  }
  for (const profile of ["", "a".repeat(129), "../work", "work/name", " work", "work ", ".work", "a\n"]) {
    assert.throws(() => assertProfileName(profile), /--profile/);
  }
});

test("legacy Home-global Runtime state migrates into default without losing the older profile copy", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-profile-layout-"));
  const paths = runtimePaths(home, "default");
  try {
    await mkdir(join(home, "profiles/default/identity"), { recursive: true });
    await mkdir(join(home, "profiles/default/credentials"), { recursive: true });
    await mkdir(join(home, "identity"), { recursive: true });
    await mkdir(join(home, "credentials"), { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      schema_version: 1,
      default_profile: "default",
      enabled_profiles: ["default"],
      channel: "stable"
    }));
    await writeFile(join(home, "profiles/default/config.json"), JSON.stringify({
      schema_version: 1,
      profile: "default",
      server_url: "https://server.example",
      runtime_name: "default"
    }));
    await writeFile(join(home, "profiles/default/identity/runtime.json"), "stale-identity");
    await writeFile(join(home, "profiles/default/credentials/runtime-token.json"), "stale-credential");
    await writeFile(join(home, "identity/runtime.json"), "current-identity");
    await writeFile(join(home, "credentials/runtime-token.json"), "current-credential");
    await writeFile(join(home, "agent-work.db"), "current-outbox");

    assert.equal(await migrateLegacyProfileLayout(paths), true);
    assert.equal(await readFile(paths.identity, "utf8"), "current-identity");
    assert.equal(await readFile(paths.credential, "utf8"), "current-credential");
    assert.equal(await readFile(join(home, "agent-work.db"), "utf8"), "current-outbox");
    await assert.rejects(access(join(paths.profileRoot, "agent-work.db")), { code: "ENOENT" });
    assert.equal(
      await readFile(join(home, "run/profile-layout-v1-backup/default/overridden/identity/runtime.json"), "utf8"),
      "stale-identity"
    );
    await assert.rejects(access(join(home, "profiles/default")), error => error.code === "ENOENT");
    assert.equal(await migrateLegacyProfileLayout(paths), false);

    await reconcileHomeConfiguration(paths, "default", "stable");
    const root = await readJsonFile(paths.rootConfig);
    assert.equal(root.default_profile, "default");
    assert.equal(root.enabled_profiles, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("obsolete database files do not trigger profile migration", async () => {
  const home = await mkdtemp(join(tmpdir(), "oh-profile-layout-live-"));
  const paths = runtimePaths(home, "default");
  try {
    await writeFile(join(home, "agent-work.db"), "live-outbox");
    assert.equal(await migrateLegacyProfileLayout(paths, true), false);
    assert.equal(await readFile(join(home, "agent-work.db"), "utf8"), "live-outbox");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
