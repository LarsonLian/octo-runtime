import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { AgentExecutor } from "@mininglamp-oss/octo-runtime/executor-core";
import { createExecutorFixture } from "../test-support/executor-adapter.mjs";
import { invokeRequest, preparedFrames } from "./runtime-fixture.js";

const terminal = (mode) =>
  mode === "native"
    ? { kind: "control", control: { type: "state", state: "completed" } }
    : { protocolVersion: 2, type: "run.completed", payload: {} };
const progress = (mode) =>
  mode === "native"
    ? { kind: "native", messageKind: "notification", payload: {} }
    : { protocolVersion: 2, type: "message.delta", payload: { channel: "final", text: "x" } };
const advance = async (t, ms) => {
  t.mock.timers.tick(ms);
  await nextTurn();
  t.mock.timers.tick(0);
  await nextTurn();
};

for (const mode of ["native", "canonical"]) {
  for (const scenario of [
    "blocked-next",
    "blocked-return",
    "split-budget",
    "within-budget",
    "paused-cancel"
  ]) {
    test(`${mode}: ${scenario} shares one cleanup deadline`, async (t) => {
      t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
      t.mock.method(performance, "now", () => Date.now());
      const core = new AgentExecutor();
      let reads = 0,
        returns = 0;
      core.register({
        ...createExecutorFixture(),
        invoke: () => ({
          [Symbol.asyncIterator]() {
            return this;
          },
          next() {
            if (++reads === 1)
              return Promise.resolve({
                done: false,
                value: scenario === "paused-cancel" ? progress(mode) : terminal(mode)
              });
            if (scenario === "blocked-return") return Promise.resolve({ done: true });
            if (scenario === "split-budget" || scenario === "within-budget")
              return new Promise((resolve) =>
                setTimeout(() => resolve({ done: true }), scenario === "within-budget" ? 40 : 80)
              );
            return new Promise(() => {});
          },
          return() {
            returns++;
            if (scenario === "split-budget" || scenario === "within-budget")
              return new Promise((resolve) =>
                setTimeout(() => resolve({ done: true }), scenario === "within-budget" ? 40 : 80)
              );
            return new Promise(() => {});
          }
        })
      });
      const source = preparedFrames(
        core,
        "executor-fixture",
        invokeRequest({ invocationId: "budget", runtimeLimits: { cancelGraceMs: 100 } }),
        { protocolMode: mode }
      );
      await source.next();
      if (scenario === "paused-cancel") {
        while (!reads) await source.next();
        core.cancel("budget");
        await nextTurn();
        await advance(t, 200);
      }
      let frames;
      const collecting = Array.fromAsync(source).then((value) => {
        frames = value;
      });
      await nextTurn();
      if (scenario === "split-budget") {
        await advance(t, 80);
        await advance(t, 20);
      } else if (scenario === "within-budget") {
        await advance(t, 40);
        await advance(t, 40);
      } else if (scenario !== "paused-cancel") await advance(t, 100);
      else await advance(t, 0);
      assert.ok(frames, "resuming or entering catch must not grant another grace period");
      assert.equal(
        frames.at(-1).control.state,
        scenario === "paused-cancel"
          ? "cancelled"
          : scenario === "within-budget"
            ? "completed"
            : "failed"
      );
      assert.equal(returns, 1);
      const closing = core.shutdown("test", 1);
      await advance(t, 1);
      assert.equal(
        (await closing).cleanup,
        scenario === "within-budget" ? "complete" : "incomplete"
      );
      await collecting;
    });
  }

  for (const abort of [false, true]) {
    test(`${mode}: late next rejection after ${abort ? "cancel" : "deadline"} is observed`, async () => {
      const blocked = Promise.withResolvers();
      const core = new AgentExecutor();
      core.register({
        ...createExecutorFixture(),
        async *invoke() {
          yield abort ? progress(mode) : terminal(mode);
          await blocked.promise;
        }
      });
      const source = preparedFrames(
        core,
        "executor-fixture",
        invokeRequest({ invocationId: "late", runtimeLimits: { cancelGraceMs: 100 } }),
        { protocolMode: mode }
      );
      await source.next();
      const collecting = Array.fromAsync(source);
      await nextTurn();
      if (abort) core.cancel("late");
      assert.equal((await collecting).at(-1).control.state, abort ? "cancelled" : "failed");
      blocked.reject(new Error("late provider read rejection"));
      await nextTurn();
      assert.equal((await core.shutdown()).cleanup, "incomplete");
    });
  }
}
