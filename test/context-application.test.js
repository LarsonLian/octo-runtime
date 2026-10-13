import test from "node:test";
import assert from "node:assert/strict";
import { createCodexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";
import { assertCanonicalEvent } from "@mininglamp-oss/octo-harness-protocol";
import { codexAppServerFixture, invokeRequest } from "./agent-work-runtime-fixture.js";

const compilation = {
  compiler_version: "octo.context-compiler/v4", catalog_version: "octo.context-catalog/v3",
  context_hash: "sha256:" + "a".repeat(64), compiled_hash: "sha256:" + "b".repeat(64),
  run_id: "run-1", lease_id: "lease-1", fencing_token: 1
};

test("Codex reports application after acknowledgement without rewriting native skills", async () => {
  const server = codexAppServerFixture({ skills: [{ name: "local", path: "/user/SKILL.md", enabled: true }] });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const iterator = adapter.invoke(invokeRequest({ runMetadata: { contextCompilation: compilation }, signal: AbortSignal.timeout(2_000) }))[Symbol.asyncIterator]();
  try {
    const event = (await iterator.next()).value;
    assert.equal(event.type, "context.applied");
    assertCanonicalEvent(event);
    assert.equal(event.payload.compiled_hash, compilation.compiled_hash);
    assert.ok(!Object.hasOwn(event.payload, "loaded_skills"));
    assert.ok(server.writes.some(value => value.method === "turn/start"));
    assert.ok(!server.writes.some(value => value.method.startsWith("skills/")));
  } finally { await iterator.return(); }
});

test("rejected Provider invocation never reports application", async () => {
  const server = codexAppServerFixture({ turnStartError: "denied by Provider" });
  const adapter = createCodexAdapter({ command: "fixture", spawnFn: server.spawnFn });
  const events = [];
  for await (const event of adapter.invoke(invokeRequest({ runMetadata: { contextCompilation: compilation }, signal: AbortSignal.timeout(2_000) }))) events.push(event);
  assert.equal(events.at(-1).type, "run.failed");
  assert.equal(events.some(value => value.type === "context.applied"), false);
});
