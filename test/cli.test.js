import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { startDaemonServer } from "@mininglamp-oss/octo-harness-daemon-app";

const execute = promisify(execFile);

test("CLI drives daemon socket through trigger to terminal run", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-cli-"));
  const app = await startDaemonServer({
    socketPath: join(home, "sockets", "octo-harness-daemon.sock"), storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"), hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  });
  const cli = async args => JSON.parse((await execute(process.execPath, [join(root, "apps/cli/dist/index.js"), ...args], { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } })).stdout);
  try {
    const status = await cli(["status"]);
    assert.equal(status.ready, true);
    assert.equal(status.pid, process.pid);
    assert.equal(status.socketPath, join(home, "sockets", "octo-harness-daemon.sock"));
    assert.equal(status.storePath, join(home, "state.db"));
    assert.equal(status.manifestPath, join(root, "test/fixtures/adapters.json"));
    assert.equal(status.adapterHost.entrypoint, join(root, "apps/adapter-host/dist/index.js"));
    assert.equal(status.adapterHost.pid, app.hostProcess.child.pid);
    assert.deepEqual(status.adapters, ["test"]);
    assert.equal(status.logging.directory, join(home, "logs"));
    assert.equal(status.logging.fileLog, true);
    assert.equal((await cli(["--", "status"])).ready, true);
    const agent = await cli(["agent", "create", "--name", "cli-test", "--adapter", "test", "--workdir", root, "--model", "test-model"]);
    const trigger = await cli(["trigger", "create", "--name", "cli-trigger", "--agent", agent.id, "--title", "T", "--instruction", "Do T"]);
    const ack = await cli(["trigger", "fire", trigger.id, "--event-id", "cli-event-1"]);
    assert.equal(ack.accepted, true);
    const completed = await cli(["run", "wait", ack.runId]);
    assert.equal(completed.run.status, "completed");
    assert.equal(completed.events.at(-1).type, "run.finished");

    const chat = await cli(["chat", "create", "--agent", agent.id, "--title", "Follow test"]);
    const followed = await execute(
      process.execPath,
      [join(root, "apps/cli/dist/index.js"), "chat", "send", chat.id, "--prompt", "stream me", "--follow"],
      { cwd: root, env: { ...process.env, OCTO_HARNESS_HOME: home } }
    );
    const frames = followed.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.equal(frames[0].kind, "ack");
    assert.equal(frames[0].result.agent.id, agent.id);
    assert.equal(frames[0].result.agent.adapterType, "test");
    const eventFrames = frames.filter(frame => frame.kind === "event");
    assert.deepEqual(eventFrames.map(frame => frame.event.seq), eventFrames.map((_frame, index) => index + 1));
    assert.equal(eventFrames[0].event.type, "run.queued");
    assert.equal(eventFrames.at(-1).event.type, "run.finished");
    assert.equal(frames.at(-1).kind, "done");
    assert.equal(frames.at(-1).result.run.status, "completed");
    const trace = await cli(["logs", "query", frames[0].result.runId]);
    const chatTurn = trace.find(record => record.event === "chat_turn.dispatch.accepted");
    assert.match(chatTurn.data.chat_turn_id, /^turn_local_/);
    const traceAfterRefresh = await cli(["logs", "query", frames[0].result.runId]);
    assert.equal(traceAfterRefresh.some(record => record.data?.method === "logs.query"), false);

    const firstPage = await daemonCall(app.runtime.socketPath, "logs.viewer", {
      runId: frames[0].result.runId,
      limit: 2,
      fromSeq: 1
    });
    assert.equal(firstPage.selectedRunId, frames[0].result.runId);
    const runSummary = firstPage.runs.find(run => run.runId === frames[0].result.runId);
    assert.equal(runSummary.status, "completed");
    assert.equal(runSummary.sessionId, chat.id);
    assert.equal(runSummary.conversation.title, "Follow test");
    assert.match(runSummary.chatTurnId, /^turn_local_/);
    assert.match(runSummary.invocationId, /^invoke_/);
    assert.equal(runSummary.adapterType, "test");
    assert.equal(runSummary.model, "test-model");
    assert.equal(runSummary.providerSessionId, `test:${chat.id}`);
    assert.match(runSummary.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(runSummary.endedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(runSummary.durationMs >= 0, true);
    assert.equal(runSummary.stalled, false);
    assert.equal(runSummary.stallMs, 0);
    assert.equal(runSummary.eventCount, eventFrames.length);
    assert.equal(firstPage.events.length, 2);
    assert.equal(firstPage.events.every(event => !("payload" in event)), true);
    assert.equal(firstPage.nextSeq, 3);
    assert.equal(firstPage.records.length > 0, true);
    assert.equal(firstPage.records.length <= 2, true);
    assert.equal(typeof firstPage.cursor, "string");
    assert.equal(firstPage.hasMore, true);

    const secondPage = await daemonCall(app.runtime.socketPath, "logs.viewer", {
      runId: frames[0].result.runId,
      limit: 2,
      after: firstPage.cursor,
      fromSeq: firstPage.nextSeq
    });
    const firstRecordKeys = new Set(firstPage.records.map(record => `${record.process_instance_id}:${record.seq}`));
    assert.equal(secondPage.records.every(record => !firstRecordKeys.has(`${record.process_instance_id}:${record.seq}`)), true);
    assert.equal(secondPage.events[0].seq, 3);
    assert.equal(secondPage.records.some(record => record.data?.method === "logs.viewer"), false);

    const invalidCursor = await daemonCallResponse(app.runtime.socketPath, "logs.viewer", { after: "not-a-cursor" });
    assert.match(invalidCursor.error.message, /valid viewer cursor/);
  } finally {
    await app.close(); await rm(home, { recursive: true, force: true });
  }
});

async function daemonCall(socketPath, method, params = {}) {
  const response = await daemonCallResponse(socketPath, method, params);
  if (response.error) throw new Error(response.error.message);
  return response.result;
}

async function daemonCallResponse(socketPath, method, params = {}) {
  const socket = await new Promise((resolveSocket, reject) => {
    const candidate = net.createConnection(socketPath);
    candidate.once("connect", () => resolveSocket(candidate));
    candidate.once("error", reject);
  });
  socket.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`);
  return new Promise((resolveResponse, reject) => {
    createInterface({ input: socket }).once("line", line => {
      try {
        resolveResponse(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

test("CLI explains how to start a missing daemon", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "octo-harness-cli-missing-daemon-"));
  try {
    await assert.rejects(
      execute(process.execPath, [join(root, "apps/cli/dist/index.js"), "status"], {
        cwd: root,
        env: { ...process.env, OCTO_HARNESS_HOME: home }
      }),
      error => error.stderr.includes("start it with: octo-harness daemon")
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
