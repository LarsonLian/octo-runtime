import test from "node:test";
import assert from "node:assert/strict";
import { SharedRunAdmission } from "../apps/daemon/dist/agent-work-supervisor.js";

test("shared admission rejects an already aborted signal with an Error", async () => {
  const admission = new SharedRunAdmission(1);
  const controller = new AbortController();
  controller.abort("cancelled profile");
  await assert.rejects(admission.acquire(controller.signal), error =>
    error instanceof Error && error.cause === "cancelled profile");
  assert.equal(admission.active, 0);
});

test("cancelling a queued profile preserves shared capacity and releases the next profile", async () => {
  const admission = new SharedRunAdmission(1);
  const release = await admission.acquire(new AbortController().signal);
  const controller = new AbortController();
  const cancelled = admission.acquire(controller.signal);
  const rejection = assert.rejects(cancelled, error =>
    error instanceof Error && error.cause === "queued profile cancelled");
  controller.abort("queued profile cancelled");
  await rejection;
  assert.equal(admission.active, 1);
  const waiting = admission.acquire(new AbortController().signal);
  release();
  release();
  const releaseNext = await waiting;
  assert.equal(admission.active, 1);
  releaseNext();
  assert.equal(admission.active, 0);
});
