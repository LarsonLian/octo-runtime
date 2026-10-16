import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeLogging } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { ExtraPlugins } from "../packages/octo-runtime-daemon/dist/index.js";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "octo-metadata-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function records(directory, subdirectory = "") {
  const root = join(directory, subdirectory);
  const names = await readdir(root);
  return (
    await Promise.all(
      names
        .filter((name) => name.endsWith(".log"))
        .map((name) => readFile(join(root, name), "utf8"))
    )
  )
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
test("F31 disabled logging creates no files, rejects implicit directories, and never serializes bodies", async (t) => {
  const directory = await fixture(t),
    disabled = new RuntimeLogging();
  disabled.extra("fixture")("info", "fixture.started", { text: "private" });
  await disabled.close();
  assert.deepEqual(await readdir(directory), []);
  assert.throws(() => new RuntimeLogging({ directory: "relative" }), /ABSOLUTE/);
  const logging = new RuntimeLogging({ directory });
  const extras = new ExtraPlugins(
    [
      {
        name: "fixture",
        config: {},
        load: async () => ({
          name: "fixture",
          default: async (ctx) => {
            assert.equal(typeof ctx.log, "function");
            ctx.log("info", "fixture.started", {
              extra_type: "forged",
              status: "running",
              token: "bf_secret",
              error: Error("secret"),
              input: "SECRET_INPUT",
              context: { text: "SECRET_CONTEXT" },
              model: "bf_secret"
            });
          }
        })
      }
    ],
    {},
    (name) => logging.extra(name)
  );
  await extras.loadConfigured();
  await extras.close();
  await logging.close();
  const rows = await records(directory, "extras");
  assert.equal(rows[0].extra_type, "fixture");
  assert.equal(rows[0].source, "extra");
  assert.deepEqual(rows[0].data, { status: "running" });
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|bf_secret|forged/);
});
test("F31 kernel lifecycle counts only this input/context and keeps execution independent of logging", async (t) => {
  const directory = await fixture(t),
    logging = new RuntimeLogging({ directory });
  const host = new AdapterHost({ log: logging.kernel });
  host.register({
    metadata: {
      type: "fixture",
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "fixture.canonical", modes: ["canonical"], nativeMethods: [] }
    },
    async *invoke() {
      yield { protocolVersion: 2, type: "run.completed", payload: { text: "SECRET_REPLY" } };
    }
  });
  const input = {
    inputs: [{ type: "text", text: "SECRET_INPUT" }],
    contexts: {
      schema: "octo.context-envelope/v3",
      items: [
        { namespace: "octo.execution", name: "adapter", payload: { type: "fixture" } },
        { namespace: "extra.im", name: "rules", payload: { text: "SECRET_CONTEXT" } }
      ]
    },
    approvalMode: "full_access",
    sessionId: "session-log",
    invocationId: "invocation-log",
    runId: "run-log",
    protocol_mode: "canonical"
  };
  const events = [];
  for await (const event of host.invoke(input)) events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
  await assert.rejects(async () => {
    for await (const _ of host.invoke({ ...input, invocationId: "bad", inputs: [] })) void _;
  });
  await host.shutdown();
  await logging.close();
  const rows = await records(directory);
  assert.equal(rows.find((row) => row.event === "invoke.received").data.input_count, 1);
  assert.equal(rows.find((row) => row.event === "invoke.received").data.context_count, 1);
  assert.equal(rows.find((row) => row.event === "invoke.finished").data.status, "completed");
  assert.ok(rows.some((row) => row.event === "invoke.rejected"));
  assert.ok(rows.some((row) => row.event === "invoke.started"));
  assert.doesNotMatch(JSON.stringify(rows), /SECRET|payload|instructions/);
  const failing = new AdapterHost({
    log: () => {
      throw Error("disk unavailable");
    }
  });
  await assert.rejects(
    async () => {
      for await (const _ of failing.invoke({ ...input, inputs: [] })) void _;
    },
    (error) => !String(error).includes("disk unavailable")
  );
});
test("F31 log queue is bounded and filesystem failure does not reach callers", async (t) => {
  const directory = await fixture(t),
    logging = new RuntimeLogging({ directory });
  for (let i = 0; i < 10000; i++) logging.kernel("info", "fixture.burst", { attempt: i });
  await logging.close();
  assert.ok((await records(directory)).length <= 128);
  const blocked = join(directory, "blocked");
  await writeFile(blocked, "file");
  const failed = new RuntimeLogging({ directory: blocked });
  failed.kernel("error", "fixture.failure", { code: "DISK_FAILED" });
  await failed.close();
});
