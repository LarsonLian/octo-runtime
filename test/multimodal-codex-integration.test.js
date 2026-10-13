import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { createCodexAdapter } from "@mininglamp-oss/octo-harness-adapter-codex";
import { resolveRuntimeInputImages } from "../packages/octo-harness-worker-access/dist/input-images.js";
import { mapExecutionEnvelope } from "../packages/octo-harness-worker-access/dist/agent-work-runtime.js";
import { contextEnvelope, executionContext, resolvedRuntimeSelection } from "./agent-work-runtime-fixture.js";
import { visualInputImages } from "../test-support/multimodal-images.mjs";

test("frozen artifacts cross runtime mapping and Host into a real Codex three-image turn", {
  skip: process.env.OCTO_CODEX_MULTIMODAL_LIVE !== "1", timeout: 180_000
}, async () => {
  const workdir = await mkdtemp(join(tmpdir(), "octo-mm-integration-"));
  const images = visualInputImages();
  const artifacts = images.map((image, index) => ({ artifact_id: `artifact-${index + 1}`, mediaType: image.mimeType, byteSize: image.byteSize, sha256: image.sha256 }));
  const runId = `run-${randomUUID()}`;
  const leaseId = "fixture-lease";
  const fencingToken = 19;
  const authorization = "Bearer fixture-runtime";
  const reads = [];
  const input = { version: 1, parts: [
    { id: "question", type: "text", text: 'Identify the main shape and its color in each supplied image, in order. Reply with only a JSON array of three objects using keys "shape" and "color" and English lowercase values. Inspect the supplied images directly and do not call tools.' },
    ...artifacts.map((artifact, index) => ({ id: `picture-${index + 1}`, type: "image", artifact }))
  ] };
  const frozenInput = structuredClone(input);
  // This fixture models the authority's frozen-resource read, rather than public URL downloads.
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    reads.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (req.method !== "POST" || req.url !== "/v1/runtime/input_artifact/read"
      || req.headers.authorization !== authorization || body.run_id !== runId || body.lease_id !== leaseId || body.fencing_token !== fencingToken) {
      res.writeHead(403).end();
      return;
    }
    const index = artifacts.findIndex(artifact => artifact.id === body.artifact_id);
    if (index < 0) { res.writeHead(404).end(); return; }
    const { type: _type, ...source } = images[index];
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { artifact: artifacts[index], source } }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const materializedInput = await resolveRuntimeInputImages(input, {
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      runId, leaseId, fencingToken, signal: AbortSignal.timeout(170_000)
    });
    assert.deepEqual(input, frozenInput);
    assert.equal(input.parts.some(part => Object.hasOwn(part, "source")), false);
    assert.deepEqual(reads, artifacts.map(artifact => ({
      method: "POST", path: "/v1/runtime/input_artifact/read", authorization,
      body: { run_id: runId, artifact_id: artifact.id, lease_id: leaseId, fencing_token: fencingToken }
    })));
    const plan = { agent_source: "provisioned", adapter_type: "codex", workdir, approval_mode: "ask", ...(process.env.OCTO_CODEX_MULTIMODAL_MODEL ? { model: process.env.OCTO_CODEX_MULTIMODAL_MODEL } : {}) };
    const envelope = {
      schema_version: 7, session_scope_id: "fixture-scope", effective_context: executionContext(plan), context_configuration_version: 1,
      resolved_execution_plan: plan, resolved_runtime_selection: resolvedRuntimeSelection(),
      run_id: runId, agent_session_id: `session-${randomUUID()}`,

      agent_run_request: {
        namespace: "work", agent_id: "fixture-agent", session_id: "v1/work/multimodal-integration",
        trigger: { kind: "manual", occurrence_id: `message-${randomUUID()}` }, input: materializedInput, context: contextEnvelope()
      }
    };
    const { adapterType, request } = mapExecutionEnvelope(envelope);
    request.agentConfig.sandbox = "read-only";
    request.signal = AbortSignal.timeout(160_000);
    assert.equal(adapterType, "codex");
    assert.deepEqual(request.modelInputParts.filter(part => part.id).map(part => part.id), input.parts.map(part => part.id));
    assert.deepEqual(request.modelInputParts.filter(part => part.type === "image").map(part => part.sha256), artifacts.map(artifact => artifact.sha256));
    assert.deepEqual(request.runMetadata.input, frozenInput);
    const host = new AdapterHost();
    host.register(createCodexAdapter());
    const events = [];
    for await (const event of host.invoke(adapterType, request, { protocolMode: "canonical" })) events.push(event);
    assert.equal(events.at(-1).type, "run.completed", JSON.stringify(events.at(-1)));
    const answer = events.filter(event => event.type === "message.delta" && event.payload.channel === "final").map(event => event.payload.text ?? "").join("");
    const parsed = JSON.parse(answer.slice(answer.indexOf("["), answer.lastIndexOf("]") + 1));
    assert.deepEqual(parsed, [{ shape: "circle", color: "red" }, { shape: "square", color: "green" }, { shape: "triangle", color: "blue" }]);
    for (const image of images) {
      assert.equal(JSON.stringify(request.runMetadata).includes(image.data), false);
    }
    assert.deepEqual(input, frozenInput);
    console.log(JSON.stringify({ evidence: "artifact-runtime-host-codex-native-three-image", runId,
      providerSession: events.find(event => event.type === "session.update")?.payload.providerSession,
      artifactReads: reads.length, leaseVerified: true, fencingVerified: true,
      images: artifacts.map(({ id, sha256, byteSize }) => ({ id, sha256, byteSize })), answer: parsed }));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(workdir, { recursive: true, force: true });
  }
});
