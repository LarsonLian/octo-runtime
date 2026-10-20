import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runZcodeAppServerTurn } from "@mininglamp-oss/octo-runtime-adapter-zcode-gui";
import { invokeRequest } from "./runtime-fixture.js";

for (const cleanupFails of [false, true]) {
  test(`ZCode attempts caller cleanup after process cleanup fails; caller failure=${cleanupFails}`, async (t) => {
    const processError = new Error("process cleanup failed"),
      callerError = new Error("caller cleanup failed");
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const request = JSON.parse(chunk.toString());
        queueMicrotask(() =>
          child.stdout.write(
            JSON.stringify({
              id: request.id,
              error: { code: 1, message: "initialization failed" }
            }) + "\n"
          )
        );
        callback();
      }
    });
    // No PID or real process: failure injection cannot send an OS signal.
    child.kill = () => {
      throw processError;
    };
    t.after(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    });
    let cleanups = 0;
    const frames = [];
    const source = runZcodeAppServerTurn({
      request: invokeRequest({ approvalMode: "full_access" }),
      spec: {
        command: "fixture",
        args: [],
        cwd: process.cwd(),
        env: {},
        cleanup: () => {
          cleanups++;
          if (cleanupFails) throw callerError;
        }
      },
      spawnFn: () => child
    });
    await assert.rejects(
      async () => {
        for await (const frame of source) frames.push(frame);
      },
      (error) => {
        if (cleanupFails) assert.deepEqual(error.errors, [processError, callerError]);
        else assert.equal(error, processError);
        return true;
      }
    );
    assert.equal(cleanups, 1);
    assert.equal(frames.at(-1).type, "run.failed");
    assert.match(frames.at(-1).payload.message, /initialization failed/);
  });
}
