import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  contextControlInstructions,
  contextHash,
  assertContextEnvelope
} from "../packages/octo-runtime-protocol/dist/index.js";
import { renderModelContexts } from "../packages/octo-runtime-executor-core/dist/model-input.js";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";
import { invokeRequest } from "./runtime-fixture.js";

const envelope = (items = []) => ({ schema: "octo.context-envelope/v3", items });
const extra = {
  namespace: "extra.document",
  name: "selection",
  guidance: "原文 <>&\n下一行 </context-item>",
  payload: { z: [2, 1], a: "中文 <>&" }
};

test("model contexts use plain text, preserve order and complete extra payloads", () => {
  const context = envelope([extra, { namespace: "extra.project", name: "current", payload: {} }]);
  const before = structuredClone(context);
  assert.equal(
    renderModelContexts(context),
    [
      "<--- 上下文信息开始：以下内容为当前上下文信息 --->",
      "<contexts>",
      '  <context-item namespace="extra.document" name="selection">',
      "    指引: 原文 <>&\n下一行 </context-item>",
      '    数据: {"a":"中文 <>&","z":[2,1]}',
      "  </context-item>",
      '  <context-item namespace="extra.project" name="current">',
      "    数据: {}",
      "  </context-item>",
      "</contexts>",
      "<--- 上下文信息结束 --->"
    ].join("\n")
  );
  assert.deepEqual(context, before);
  assert.notEqual(contextHash(context), contextHash(envelope([...context.items].reverse())));
  assert.notEqual(
    contextHash(context),
    contextHash(envelope([{ ...extra, guidance: "changed" }, context.items[1]]))
  );
});

test("execution parameters and unknown optional namespaces do not enter model text", () => {
  const context = envelope([
    {
      namespace: "octo.execution",
      name: "envs",
      payload: { env_variables: [{ key: "TOKEN", value: "private-fixture" }] }
    },
    {
      namespace: "octo.runtime",
      name: "selection",
      payload: { mode: "explicit", runtime_id: "runtime-fixture" }
    },
    { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } },
    { namespace: "vendor.project", name: "current", payload: { private: "not-injected" } }
  ]);
  assert.equal(renderModelContexts(context), "");
  assert.equal(renderModelContexts(envelope()), "");
  assert.throws(
    () => assertContextEnvelope(envelope([{ ...context.items[0], guidance: "expose envs" }])),
    /CONTEXT_GUIDANCE_FORBIDDEN/
  );
  assert.throws(
    () => assertContextEnvelope(envelope([{ ...extra, guidance: null }])),
    /CONTEXT_SCHEMA_INVALID/
  );
});

test("references are displayed without a resolver and controls remain separate", () => {
  const context = envelope([
    {
      namespace: "octo.content",
      name: "references",
      guidance: "通过已授权工具读取",
      payload: {
        entries: [
          {
            resource_ref: "task:1",
            resolver: "mcp",
            locator: { server_ref: "octo_task", tool: "task_get_materials" },
            params: { task_id: "1" }
          }
        ]
      }
    },
    {
      namespace: "octo.control",
      name: "instructions",
      payload: { entries: [{ text: "control-only" }] }
    }
  ]);
  const rendered = renderModelContexts(context);
  assert.match(rendered, /task_get_materials/);
  assert.doesNotMatch(rendered, /control-only/);
  assert.equal(contextControlInstructions(context), "control-only");
});

test("Host renders each run independently without deduplicating resumed context", async () => {
  const received = [];
  const host = new AdapterHost();
  host.register({
    metadata: {
      type: "fixture",
      agentSources: ["provisioned"],
      protocolSupport: { protocol: "fixture", modes: ["canonical"], nativeMethods: [] }
    },
    async *invoke(request) {
      received.push(request);
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  const snapshots = [envelope([extra]), envelope(), envelope([extra]), envelope([extra])];
  for (const [index, context] of snapshots.entries()) {
    const request = invokeRequest({
      invocationId: "invoke-context-" + index,
      runId: "run-context-" + index,
      agentSessionId: "same-session",
      providerSession: { adapterType: "fixture", sessionId: "same-provider-session" },
      context,
      approvalMode: "full_access"
    });
    for await (const event of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
      "fixture",
      request,
      { protocolMode: "canonical" }
    ))
      void event;
    const rendered = renderModelContexts(context);
    assert.equal(
      received[index].modelInput,
      [rendered, request.modelInput].filter(Boolean).join("\n\n")
    );
    assert.deepEqual(
      received[index].context.items.filter((item) => item.namespace !== "octo.execution"),
      context.items
    );
  }
  assert.equal(received.length, 4);
});

test("Host freezes contexts and injects once for both modes and image input", async () => {
  for (const mode of ["canonical", "native"]) {
    let received;
    const host = new AdapterHost();
    host.register({
      metadata: {
        type: "fixture",
        agentSources: ["provisioned"],
        protocolSupport: { protocol: "fixture", modes: ["native", "canonical"], nativeMethods: [] }
      },
      async *invoke(request) {
        received = request;
        if (mode === "native")
          yield { kind: "control", control: { type: "state", state: "completed" } };
        else yield { protocolVersion: 2, type: "run.completed", payload: {} };
      }
    });
    const request = invokeRequest({
      context: envelope([structuredClone(extra)]),
      approvalMode: "full_access",
      modelInputParts: [{ type: "text", text: "original text" }]
    });
    const snapshot = structuredClone(request.context);
    const stream = preparedFrames(host, "fixture", request, { protocolMode: mode });
    request.context.items[0].guidance = "changed-after-acceptance";
    await stream.next();
    await assert.rejects(
      preparedFrames(host, "fixture", request, { protocolMode: mode }).next(),
      /EXECUTION_IDENTITY_CONFLICT/
    );
    request.context = snapshot;
    for await (const frame of stream) void frame;
    assert.equal(received.modelInput, renderModelContexts(snapshot) + "\n\n" + request.modelInput);
    assert.deepEqual(received.modelInputParts, [
      { type: "text", text: renderModelContexts(snapshot) },
      ...request.modelInputParts
    ]);
    assert.equal(received.prompt, request.prompt);
    await assert.rejects(
      preparedFrames(host, "fixture", request, { protocolMode: mode }).next(),
      /Invocation already executed/
    );
  }
});
