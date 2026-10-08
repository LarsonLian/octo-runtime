import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";
import { assertCanonicalEvent } from "@mininglamp-oss/octo-harness-protocol";
import { codexAppServerFixture, invokeRequest } from "./agent-work-runtime-fixture.js";

const compilation = {
  compiler_version: "octo.context-compiler/v1", catalog_version: "octo.context-catalog/v1",
  context_hash: "sha256:" + "a".repeat(64), compiled_hash: "sha256:" + "b".repeat(64),
  run_id: "run-1", lease_id: "lease-1", fencing_token: 1
};

test("Codex reports application only after Provider acknowledgement and selected native skill activation", async t => {
  const providerStateDir = await mkdtemp(join(tmpdir(), "octo-context-application-"));
  t.after(() => rm(providerStateDir, { recursive: true, force: true }));
  const skill = { name: "proof", path: "/private/root/SKILL.md", invoke: false };
  const server = codexAppServerFixture({ skills: [{ ...skill, enabled: false }] });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const iterator = adapter.invoke(invokeRequest({ skills: [skill], skillRoots: ["/private/root"],
    providerStateDir, runMetadata: { contextCompilation: compilation }, signal: AbortSignal.timeout(2_000) }))[Symbol.asyncIterator]();
  try {
    const event = (await iterator.next()).value;
    assert.equal(event.type, "context.applied");
    assertCanonicalEvent(event);
    assert.equal(event.payload.compiled_hash, compilation.compiled_hash);
    assert.deepEqual(event.payload.loaded_skills, ["proof"]);
    assert.equal(event.payload.provider_ack, "turn/start");
    assert.ok(server.writes.some(value => value.method === "turn/start"));
    assert.ok(server.writes.some(value => value.method === "skills/config/write" && value.params.enabled));
    assert.doesNotMatch(JSON.stringify(event), /private|SKILL.md|instructions|invoked/);
  } finally { await iterator.return(); }
});

test("rejected Provider invocation and unavailable native skills never report applied", async t => {
  const providerStateDir = await mkdtemp(join(tmpdir(), "octo-context-application-fail-"));
  t.after(() => rm(providerStateDir, { recursive: true, force: true }));
  for (const options of [{ turnStartError: "denied by Provider" }, { skills: [] }]) {
    const server = codexAppServerFixture(options);
    const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
    const events = [];
    for await (const event of adapter.invoke(invokeRequest({ providerStateDir, runMetadata: { contextCompilation: compilation },
      ...(options.skills ? { skills: [{ name: "missing", path: "/private/missing/SKILL.md", invoke: false }] } : {}),
      signal: AbortSignal.timeout(2_000) }))) events.push(event);
    assert.equal(events.at(-1).type, "run.failed");
    assert.equal(events.some(value => value.type === "context.applied"), false);
  }
});
