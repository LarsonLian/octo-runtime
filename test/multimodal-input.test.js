import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, MemoryStore } from "@mininglamp-oss/octo-harness-core";
import { assertModelInputParts, assertInvokeRequest, modelPartsFromInput, providerInputParts, failurePayload } from "@mininglamp-oss/octo-harness-protocol";
import { redactCredentials } from "@mininglamp-oss/octo-harness-observability";
import { resolveRuntimeInputImages } from "../packages/octo-harness-daemon/dist/input-images.js";
import { mapExecutionEnvelope } from "../packages/octo-harness-daemon/dist/agent-work-runtime.js";
import { invokeRequest, contextEnvelope, executionContext, resolvedRuntimeSelection } from "./agent-work-runtime-fixture.js";
import { visualInputImages } from "../test-support/multimodal-images.mjs";

const [image] = visualInputImages();
const source = ({ type: _type, ...value }) => value;
const artifact = { id: "artifact-1", mediaType: image.mimeType, byteSize: image.byteSize, sha256: image.sha256 };
const input = () => ({ parts: [{ id: "t1", type: "text", text: "compare" }, { id: "p1", type: "image", artifact }, { id: "t2", type: "text", text: "then describe" }] });

test("ordered model input validates image content, limits, and recovery without text fallback", () => {
  const parts = [{ type: "text", text: "before" }, image, { type: "text", text: "after" }];
  assert.doesNotThrow(() => assertModelInputParts(parts));
  assert.deepEqual(providerInputParts({ ...invokeRequest(), modelInputParts: parts }), parts);
  assert.throws(() => assertModelInputParts([{ ...image, sha256: "0".repeat(64) }]), /ARTIFACT_INTEGRITY_MISMATCH/);
  assert.throws(() => assertModelInputParts([{ ...image, data: image.data + "=" }]), /ARTIFACT_INTEGRITY_MISMATCH/);
  assert.throws(() => assertModelInputParts(Array(5).fill(image)), /IMAGE_LIMIT_EXCEEDED/);
  assert.throws(() => assertModelInputParts([{ ...image, mimeType: "image/svg+xml" }]), /UNSUPPORTED_INPUT_MODALITY/);
  assert.throws(() => assertInvokeRequest({ ...invokeRequest(), modelInputParts: parts, freshFallbackModelInput: "recovery" }), /IMAGE_RECOVERY_INPUT_REQUIRED/);
  assert.throws(() => assertInvokeRequest({ ...invokeRequest(), modelInputParts: parts, freshFallbackModelInputParts: [{ type: "text", text: "lost image" }] }), /IMAGE_RECOVERY_INPUT_REQUIRED/);
  assert.throws(() => providerInputParts({ ...invokeRequest(), modelInputParts: parts, freshFallbackModelInputParts: [{ type: "text", text: "lost image" }] }, true), /IMAGE_RECOVERY_INPUT_REQUIRED/);
  const images = visualInputImages();
  assert.throws(() => assertInvokeRequest({ ...invokeRequest(), modelInputParts: images, freshFallbackModelInputParts: [...images].reverse() }), /IMAGE_RECOVERY_INPUT_REQUIRED/);
  assert.throws(() => assertInvokeRequest({ ...invokeRequest(), modelInputParts: [image], freshFallbackModelInputParts: [image, image] }), /IMAGE_RECOVERY_INPUT_REQUIRED/);
  assert.throws(() => assertModelInputParts([{ ...image, id: "same" }, { ...image, id: "same" }]), /INPUT_PART_INVALID/);
  assert.throws(() => providerInputParts({ ...invokeRequest(), modelInputParts: [image], freshFallbackImagesUnavailable: true }, true), /ARTIFACT_UNAVAILABLE/);
  assert.throws(() => modelPartsFromInput(input()), /ARTIFACT_UNAVAILABLE/);
});

test("Host refuses image input before calling an old text-only adapter", async () => {
  let called = false;
  const host = new AdapterHost();
  host.register({ metadata: { type: "text-only", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke() { called = true; } });
  await assert.rejects(async () => {
    for await (const _event of host.invoke("text-only", { ...invokeRequest(), approvalMode: "full_access", modelInputParts: [image] })) {}
  }, /UNSUPPORTED_INPUT_MODALITY/);
  assert.equal(called, false);
});

test("runtime reads frozen artifacts under lease, verifies bytes, and leaves durable input untouched", async t => {
  const requests = [];
  let corrupt = false;
  let denied = false;
  let oversized = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const data of req) chunks.push(data);
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    if (denied) { res.writeHead(403).end(); return; }
    if (oversized) { res.end(" ".repeat(3 * 1024 * 1024)); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { artifact, source: { ...source(image), ...(corrupt ? { data: Buffer.from("changed").toString("base64") } : {}) } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { baseUrl: `http://127.0.0.1:${server.address().port}`, headers: { Authorization: "Bearer test-runtime", "Content-Type": "application/json" }, runId: "run-1", leaseId: "lease-1", fencingToken: 9, signal: new AbortController().signal };
  const original = input();
  const materialized = await resolveRuntimeInputImages(original, options);
  assert.equal(original.parts[1].source, undefined);
  assert.deepEqual(modelPartsFromInput(materialized).map(part => part.type), ["text", "image", "text"]);
  assert.deepEqual(requests[0], { url: "/v1/runtime/input_artifact/read", authorization: "Bearer test-runtime", body: { run_id: "run-1", artifact_id: artifact.id, lease_id: "lease-1", fencing_token: 9 } });
  corrupt = true;
  await assert.rejects(resolveRuntimeInputImages(input(), options), /ARTIFACT_INTEGRITY_MISMATCH/);
  corrupt = false; denied = true;
  await assert.rejects(resolveRuntimeInputImages(input(), options), /ARTIFACT_ACCESS_DENIED/);
  denied = false; oversized = true;
  await assert.rejects(resolveRuntimeInputImages(input(), options), /IMAGE_LIMIT_EXCEEDED/);
});

test("daemon preserves mixed ordering and excludes materialized bytes from run metadata", () => {
  const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: "/tmp", approval_mode: "full_access" };
  const content = input(); content.parts[1].source = source(image); content.reply_to = { text: "quoted instruction", author_name: "Lin" };
  const envelope = {
    schema_version: 7, effective_context: executionContext(plan), context_configuration_version: 1,
    resolved_execution_plan: plan, resolved_runtime_selection: resolvedRuntimeSelection(),
    run_id: "run-1", agent_session_id: "session-1", agent_revision: { definition: {} },
    agent_run_request: { namespace: "work", agent_id: "a", agent_revision_id: "rev", session_key: "v1/work/test", trigger: { kind: "manual", occurrence_id: "message-1" }, input: content, context: contextEnvelope() }
  };
  const { request } = mapExecutionEnvelope(envelope);
  assert.deepEqual(request.modelInputParts.filter(part => part.id).map(part => part.id), ["t1", "p1", "t2"]);
  assert.match(request.modelInputParts[0].text, /Quoted message from Lin.*\nquoted instruction/);
  assert.equal(request.runMetadata.input.parts[1].source, undefined);
  assert.doesNotThrow(() => assertInvokeRequest(request));
  assert.equal(envelope.agent_run_request.input.parts[1].source.data, image.data);
  const snapshot = { ref: {}, facts: [], recoveryFacts: [{ parts: [{ type: "image", url: "https://example.test/old.png" }] }], renderedText: "", recoveryRenderedText: "historical image reference", selectedVariant: "primary" };
  const recoveryRequest = mapExecutionEnvelope(envelope, snapshot).request;
  assert.equal(recoveryRequest.freshFallbackImagesUnavailable, true);
  assert.throws(() => providerInputParts(recoveryRequest, true), /ARTIFACT_UNAVAILABLE/);
  assert.throws(() => mapExecutionEnvelope(envelope, { ...snapshot, selectedVariant: "recovery" }), /ARTIFACT_UNAVAILABLE/);
});

test("Core failed image dispatch releases the session so subsequent text can run", async () => {
  const store = new MemoryStore();
  let rejectImage = true;
  const captured = [];
  const host = { list: () => [{ type: "test" }], cancel: () => true, async *invoke(_adapter, request) {
    if (rejectImage) throw new Error("UNSUPPORTED_INPUT_MODALITY");
    captured.push(request);
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  } };
  const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: contextEnvelope([ { namespace: "octo.execution", name: "adapter", payload: { type: "test" } }, { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: process.cwd() } }, { namespace: "octo.security", name: "approval_policy", payload: { mode: "full_access" } } ]) });
  const submit = occurrenceId => ({ namespace: "local", agentId: agent.id, sessionKey: "v1/task/image", trigger: { kind: "manual", occurrenceId }, context: contextEnvelope(), input: {} });
  const mixed = input(); mixed.parts[1].source = source(image);
  const first = await engine.submitAgentRun({ ...submit("image"), input: mixed });
  await assert.rejects(engine.executeRun(first.agentRun.id), /UNSUPPORTED_INPUT_MODALITY/);
  assert.equal(store.getAgentRun(first.agentRun.id).status, "failed");
  assert.equal(store.getAgentSession(first.agentSession.id).activeRunId, undefined);
  rejectImage = false;
  const second = await engine.submitAgentRun({ ...submit("text"), input: { prompt: "text still works" } });
  await engine.executeRun(second.agentRun.id);
  assert.equal(captured[0].modelInput, "text still works");
});

test("image payloads never appear in shared diagnostics and failures keep actionable reasons", () => {
  const projected = redactCredentials({ prompt: [image, { type: "image", url: `data:image/png;base64,${image.data}` }] });
  assert.equal(JSON.stringify(projected).includes(image.data), false);
  assert.equal(projected.prompt[0].sha256, image.sha256);
  for (const code of ["UNSUPPORTED_INPUT_MODALITY", "IMAGE_LIMIT_EXCEEDED", "ARTIFACT_UNAVAILABLE", "ARTIFACT_INTEGRITY_MISMATCH", "ARTIFACT_ACCESS_DENIED"]) {
    const failure = failurePayload(new Error(code), { defaultDomain: "runtime", stage: "input" }).failure;
    assert.equal(failure.reasonCode, code);
    assert.match(failure.code, /^OH-INP-/);
  }
});
