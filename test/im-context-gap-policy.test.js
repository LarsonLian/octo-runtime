import test from "node:test";
import assert from "node:assert/strict";
import {
  planHistoryGap,
  historyGapContext,
  gapMetadata,
  commitHistoryGap,
  compactHistoryGap
} from "../packages/octo-runtime-extra-channel-gateway/dist/application/context-gap.js";
import { MemoryImSessionStore } from "../packages/octo-runtime-extra-channel-gateway/dist/application/session-store.js";
import {
  observesImScope,
  acceptsImMessage
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";
import { build_im_contexts } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/contexts.js";
import { getChannelMessagePage } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";
import { createImInvocation } from "../packages/octo-runtime-extra-channel-gateway/dist/execution/dispatcher.js";

const source = {
  service: "https://im-test.deepminer.com.cn/api",
  spaceId: "space",
  botId: "bot",
  channelId: "group____topic",
  channelType: 5
};
const metadata = (overrides = {}) => ({
  ...gapMetadata("epoch"),
  preparedTriggerSeq: 101,
  ...overrides
});
const config = {
  api_url: source.service,
  bot_id: "bot",
  spaceId: "space",
  group_ids: ["group"],
  adapter: { adapter_type: "codex", workdir: process.cwd() }
};
const message = {
  channelId: source.channelId,
  channelType: 5,
  messageId: "104",
  messageSeq: 104,
  fromUid: "owner",
  payload: { type: 1, content: "summary", mention: { uids: ["bot"] } }
};

test("HG-23 removing history reports omitted material without asking the model to fetch it", () => {
  const items = Array.from({ length: 27 }, (_, index) => ({
    namespace: "extra.test",
    name: `explicit-${index}`,
    payload: { text: "keep" }
  }));
  items.push({
    namespace: "extra.im",
    name: "history",
    payload: { source, automatic: true, upperMessageSeq: 104, text: "recent window" }
  });
  items.push(
    historyGapContext(source, "104", {
      ...planHistoryGap(104, undefined, "epoch"),
      retrieval: "provided"
    })
  );
  const { request } = createImInvocation(
    config,
    {
      messageId: "104",
      senderId: "owner",
      conversationId: source.channelId,
      conversationKind: "thread",
      text: "summary"
    },
    { schema: "octo.context-envelope/v3", items },
    "scope",
    { id: "session", generation: 1 },
    new AbortController().signal
  );
  assert.equal(
    request.contexts.items.some((item) => item.name === "history"),
    false
  );
  assert.equal(
    request.contexts.items.find((item) => item.name === "history-gap").payload.range.beforeSeq,
    104
  );
  assert.equal(request.contexts.items.filter((item) => item.namespace === "extra.test").length, 27);
  const gap = request.contexts.items.find((item) => item.name === "history-gap");
  assert.equal(gap.payload.status, "omitted");
  assert.equal(gap.payload.materialProvided, false);
  assert.equal(gap.payload.argv, undefined);
});

test("HG-23 byte pressure compacts automatic hints without truncating explicit business material", () => {
  const plan = planHistoryGap(104, metadata(), "epoch");
  const context = {
    schema: "octo.context-envelope/v3",
    items: [
      { namespace: "extra.test", name: "explicit", payload: { text: "" } },
      historyGapContext(source, "104", plan)
    ]
  };
  const invoke = () =>
    createImInvocation(
      config,
      {
        messageId: "104",
        senderId: "owner",
        conversationId: source.channelId,
        conversationKind: "thread",
        text: "summary"
      },
      context,
      "scope",
      { id: "session", generation: 1 },
      new AbortController().signal
    );
  const text = "x".repeat(
    65536 - Buffer.byteLength(JSON.stringify(invoke().request.contexts)) + 10
  );
  context.items[0].payload.text = text;
  const { request } = invoke();
  assert.equal(request.contexts.items.find((item) => item.name === "explicit").payload.text, text);
  assert.equal(
    request.contexts.items.find((item) => item.name === "history-gap").payload.mode,
    "delta"
  );
});

test("HG-29 a configured reserved gap item is not overwritten by automatic context", async (context) => {
  context.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 404 }));
  await assert.rejects(
    build_im_contexts(config, message, "bf_fixture", new AbortController().signal, {
      initialSession: false,
      historyGap: planHistoryGap(104, metadata(), "epoch"),
      configuredItems: [
        { namespace: "extra.im", name: "history-gap", payload: { text: "explicit" } }
      ]
    }),
    /IM_CONTEXT_KEY_CONFLICT/
  );
});

for (const [name, trigger, previous, mode, limit] of [
  ["HG-02 known self output is not discussion", 103, metadata({ localOutputSeqs: [102] }), "none"],
  ["HG-03 one position is sufficient", 103, metadata(), "delta", 1],
  ["HG-04 two positions have an exact interval", 104, metadata(), "delta", 2],
  ["HG-05 fourteen positions stay below the cap", 116, metadata(), "delta", 14],
  ["HG-05 fifteen positions reach the cap", 117, metadata(), "delta", 15],
  ["HG-05 sixteen positions are capped", 118, metadata(), "delta", 15],
  ["HG-05 a large span is capped", 500, metadata(), "delta", 15],
  ["HG-05 the largest valid position is capped", 0xffffffff, metadata(), "delta", 15],
  ["HG-09 unknown baseline bootstraps fifteen", 104, undefined, "bootstrap", 15],
  ["HG-10 sequence one must not use start-zero sentinel", 1, undefined, "none"],
  ["HG-10 missing position is unavailable", undefined, metadata(), "unavailable"],
  ["HG-10 negative position is unavailable", -1, metadata(), "unavailable"],
  ["HG-10 fractional position is unavailable", 4.5, metadata(), "unavailable"],
  ["HG-10 overflowing u32 is unavailable", 2 ** 32, metadata(), "unavailable"],
  ["HG-10 rollback is not an exact gap", 100, metadata(), "unavailable"],
  [
    "HG-21 another process epoch has no baseline",
    104,
    metadata({ processEpoch: "old" }),
    "bootstrap",
    15
  ],
  ["HG-24 adjacent input needs no repeated history", 102, metadata(), "none"],
  [
    "HG-27 explicit fresh fallback loses assumed continuity",
    104,
    metadata({ continuityUnknown: true }),
    "bootstrap",
    15
  ]
])
  test(name, async (context) => {
    const plan = planHistoryGap(trigger, previous, "epoch");
    assert.equal(plan.mode, mode);
    assert.equal(plan.messageLimit, limit);
    if (mode === "delta") assert.equal(plan.earlierOmitted, plan.positionSpan > 15);
    const item = historyGapContext(source, "trigger", plan);
    if (item) {
      assert.equal(item.payload.materialProvided, false);
      assert.ok(Buffer.byteLength(JSON.stringify(item)) <= 4096);
      assert.doesNotMatch(JSON.stringify(item), /octo-cli|argv/);
    }
    const calls = [];
    context.mock.method(globalThis, "fetch", async (url, options) => {
      if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
      calls.push(JSON.parse(options.body));
      return Response.json({ more: 0, messages: [] });
    });
    await build_im_contexts(
      config,
      { ...message, messageSeq: trigger },
      "bf_fixture",
      new AbortController().signal,
      {
        initialSession: false,
        historyGap: plan
      }
    );
    if (mode === "bootstrap" || mode === "delta") {
      assert.deepEqual(calls, [
        {
          channel_id: source.channelId,
          channel_type: source.channelType,
          limit,
          start_message_seq: trigger - 1,
          end_message_seq: plan.afterSeq ?? 0,
          pull_mode: 0
        }
      ]);
      assert.ok(limit <= 15);
    } else {
      assert.equal(calls.length, 0);
    }
  });

test("HG-04 sync preserves exact inclusive-start/exclusive-end arguments and page metadata", async (context) => {
  const plan = planHistoryGap(104, metadata(), "epoch");
  const item = historyGapContext(source, "104", plan);
  assert.deepEqual(item.payload.range, { beforeSeq: 104, afterSeq: 101 });
  assert.equal(item.payload.argv, undefined);
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const input = JSON.parse(options.body);
    assert.equal(input.start_message_seq, 103);
    assert.equal(input.end_message_seq, 101);
    assert.equal(input.pull_mode, 0);
    return Response.json({
      more: 1,
      messages: [102, 103].map((sequence) => ({
        message_id: String(sequence),
        message_seq: sequence,
        payload: { type: 1, content: `fixture-${sequence}` }
      }))
    });
  });
  const page = await getChannelMessagePage({
    apiUrl: source.service,
    botToken: "bf_fixture",
    channelId: source.channelId,
    channelType: 5,
    startMessageSeq: 103,
    endMessageSeq: 101,
    limit: 2,
    pullMode: 0
  });
  assert.equal(page.more, true);
  assert.deepEqual(
    page.messages.map((entry) => entry.message_seq),
    [102, 103]
  );
});

test("HG-06 span is not a text count; missing or invalid more cannot confirm coverage", async (context) => {
  const plan = planHistoryGap(500, metadata({ localOutputSeqs: [103] }), "epoch");
  assert.equal(plan.positionSpan, 398);
  assert.equal(plan.earlierOmitted, true);
  context.mock.method(globalThis, "fetch", async () => Response.json({ messages: [] }));
  const params = {
    apiUrl: source.service,
    botToken: "bf_fixture",
    channelId: source.channelId,
    channelType: 5
  };
  assert.equal((await getChannelMessagePage(params)).more, undefined);
  context.mock.method(globalThis, "fetch", async () => Response.json({ more: 2, messages: [] }));
  await assert.rejects(getChannelMessagePage(params), /IM_HISTORY_PROTOCOL_INVALID/);
});

test("HG-11/12 observation scope does not grant execution permission or accept other spaces/groups", () => {
  assert.equal(observesImScope(config, source.channelId, 5, "space"), true);
  assert.equal(
    acceptsImMessage(config, "owner", {
      ...message,
      fromUid: "stranger",
      payload: { type: 1, content: "/reset" }
    }),
    false
  );
  for (const [settings, channel, type, space] of [
    [config, source.channelId, 5, "wrong"],
    [config, "other____topic", 5, "space"],
    [{ ...config, groups_enabled: false }, source.channelId, 5, "space"],
    [config, "owner", 1, "space"]
  ])
    assert.equal(observesImScope(settings, channel, type, space), false);
  assert.equal(acceptsImMessage(config, "owner", { ...message, fromUid: "bot" }), false);
});

test("HG-22 metadata patch is atomic, bounded, generation-fenced and does not create or renew bindings", (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: 1000 });
  const store = new MemoryImSessionStore();
  context.after(() => store.close());
  const identity = { sessionId: "session", generation: 1 };
  assert.equal(
    store.patchGap("missing", identity, () => metadata()),
    false
  );
  store.save("scope", { id: "session", generation: 1 });
  assert.equal(
    store.patchGap("scope", identity, () => metadata()),
    true
  );
  assert.equal(
    store.patchGap("scope", identity, (previous) => ({ ...previous, latestObservedSeq: 150 })),
    true
  );
  assert.equal(store.read("scope").gap.revision, 2);
  assert.equal(
    store.patchGap("scope", { ...identity, generation: 2 }, () => metadata()),
    false
  );
  assert.equal(
    store.patchGap("scope", identity, (previous) => ({
      ...previous,
      processEpoch: "x".repeat(4 << 20)
    })),
    false
  );
  assert.equal(store.read("scope").gap.latestObservedSeq, 150);
  context.mock.timers.tick(24 * 60 * 60_000 - 1);
  store.patchGap("scope", identity, (previous) => ({ ...previous, latestObservedSeq: 200 }));
  context.mock.timers.tick(1);
  assert.equal(store.read("scope"), undefined);
});

test("HG-23 only handed-off API material or an empty response clears pending history", () => {
  const plan = { ...planHistoryGap(104, metadata(), "epoch"), retrieval: "provided" };
  const full = historyGapContext(source, "104", plan);
  const compact = compactHistoryGap(full);
  assert.doesNotMatch(JSON.stringify(compact), /octo-cli|argv/);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 1024);
  const pending = commitHistoryGap(metadata(), 104, plan, compact);
  assert.equal(pending.preparedTriggerSeq, 104);
  assert.equal(pending.pendingAfterSeq, 101);
  const history = {
    namespace: "extra.im",
    name: "history",
    payload: { automatic: true, upperMessageSeq: 104, text: "actual material" }
  };
  const provided = commitHistoryGap(
    metadata({ latestObservedSeq: 999, pendingAfterSeq: 101 }),
    104,
    plan,
    history
  );
  assert.equal(provided.preparedTriggerSeq, 104);
  assert.equal(provided.latestObservedSeq, 999);
  assert.equal(provided.pendingAfterSeq, undefined);
  for (const retrieval of ["unavailable", "omitted"])
    assert.equal(
      commitHistoryGap(metadata(), 104, { ...plan, retrieval }, undefined).pendingAfterSeq,
      101
    );
  assert.equal(
    commitHistoryGap(
      metadata({ pendingAfterSeq: 101 }),
      104,
      { ...plan, retrieval: "empty" },
      undefined
    ).pendingAfterSeq,
    undefined
  );
  const oversized = historyGapContext({ ...source, channelId: "x".repeat(5000) }, "104", plan);
  assert.equal(oversized, undefined);
});

test("HG-28 custom store without patch capability receives an honest unknown baseline", () => {
  const plan = planHistoryGap(104, metadata(), "epoch", false);
  assert.equal(plan.mode, "bootstrap");
  assert.equal(plan.reason, "store-capability-unavailable");
  assert.equal(plan.afterSeq, undefined);
});

test("HG-24 failed API ranges merge with new gaps without exceeding the latest window", () => {
  const plan = planHistoryGap(104, metadata({ pendingAfterSeq: 80 }), "epoch");
  const item = historyGapContext(source, "104", plan);
  assert.equal(item.payload.range.afterSeq, 80);
  assert.equal(plan.messageLimit, 15);
  const fallback = historyGapContext(
    source,
    "104",
    planHistoryGap(
      104,
      metadata({
        pendingAfterSeq: null,
        continuityUnknown: true
      }),
      "epoch"
    )
  );
  assert.deepEqual(fallback.payload.range, { beforeSeq: 104 });
  assert.equal(fallback.payload.messageLimit, 15);
});

test("HG-07 cold history coordinates complete, omitted and truncated windows without another fetch", async (context) => {
  let page;
  let syncs = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    syncs++;
    return Response.json(page);
  });
  const entry = (sequence, content) => ({
    message_id: String(sequence),
    message_seq: sequence,
    from_uid: "peer",
    payload: { type: 1, content }
  });
  for (const [value, expectedStatus] of [
    [{ more: 0, messages: [entry(103, "recent"), entry(102, "older")] }, "provided"],
    [{ more: 1, messages: [entry(103, "recent"), entry(102, "older")] }, "partial"],
    [{ more: 1, messages: [entry(103, "recent"), entry(102, "😀".repeat(2000))] }, "partial"]
  ]) {
    page = value;
    let prepared;
    const items = await build_im_contexts(
      config,
      message,
      "bf_fixture",
      new AbortController().signal,
      {
        initialSession: true,
        historyGap: planHistoryGap(104, undefined, "epoch"),
        onHistoryGapPrepared: (plan) => {
          prepared = plan;
        }
      }
    );
    assert.equal(prepared.retrieval, expectedStatus);
    const gap = items.find((item) => item.name === "history-gap");
    assert.equal(gap.payload.range.beforeSeq, 104);
    assert.equal(gap.payload.status, expectedStatus);
    assert.equal(gap.payload.argv, undefined);
    assert.ok(items.find((item) => item.name === "history"));
  }
  assert.equal(syncs, 3);
});

test("HG-08 cold and warm API failures do not block or delegate repair to model tools", async (context) => {
  let syncs = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    syncs++;
    return Response.json({}, { status: 403 });
  });
  for (const initialSession of [true, false]) {
    const items = await build_im_contexts(
      config,
      message,
      "bf_fixture",
      new AbortController().signal,
      { initialSession, historyGap: planHistoryGap(104, undefined, "epoch") }
    );
    const item = items.find((entry) => entry.name === "history-gap");
    assert.equal(item.payload.mode, "bootstrap");
    assert.equal(item.payload.status, "unavailable");
    assert.equal(item.payload.materialProvided, false);
    assert.doesNotMatch(JSON.stringify(item), /octo-cli|argv|bf_fixture/);
  }
  assert.equal(syncs, 2);
});

test("HG-05 API preparation enforces the latest fifteen records even when the server returns more", async (context) => {
  let calls = 0;
  const entry = (sequence) => ({
    message_id: String(sequence),
    message_seq: sequence,
    from_uid: "peer",
    payload: { type: 1, content: `discussion-${sequence}` }
  });
  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    calls++;
    assert.equal(url, `${source.service}/v1/bot/messages/sync`);
    assert.equal(options.headers.Authorization, "Bearer bf_fixture");
    assert.deepEqual(JSON.parse(options.body), {
      channel_id: source.channelId,
      channel_type: 5,
      limit: 15,
      start_message_seq: 499,
      end_message_seq: 101,
      pull_mode: 0
    });
    return Response.json({
      more: 1,
      messages: [
        ...Array.from({ length: 20 }, (_, index) => entry(480 + index)),
        entry(499),
        entry(500),
        entry(501),
        entry(101)
      ]
    });
  });
  const items = await build_im_contexts(
    config,
    {
      ...message,
      messageId: "500",
      messageSeq: 500,
      payload: { type: 1, content: "what is 1 + 1?" }
    },
    "bf_fixture",
    new AbortController().signal,
    {
      initialSession: false,
      historyGap: planHistoryGap(500, metadata(), "epoch")
    }
  );
  const text = items.find((item) => item.name === "history").payload.text;
  assert.deepEqual(
    text.split("\n"),
    Array.from({ length: 15 }, (_, index) => `peer：discussion-${485 + index}`)
  );
  const gap = items.find((item) => item.name === "history-gap");
  assert.equal(gap.payload.status, "partial");
  assert.equal(gap.payload.earlierOmitted, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(items), /bf_fixture/);
});

test("HG-08 malformed API responses remain unavailable without another request", async (context) => {
  let response;
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    calls++;
    return Response.json(response);
  });
  for (response of [{ messages: "invalid" }, { messages: [], more: 2 }, null]) {
    const items = await build_im_contexts(
      config,
      message,
      "bf_fixture",
      new AbortController().signal,
      {
        initialSession: false,
        historyGap: planHistoryGap(104, metadata(), "epoch")
      }
    );
    assert.equal(items.find((item) => item.name === "history-gap").payload.status, "unavailable");
    assert.equal(
      items.some((item) => item.name === "history"),
      false
    );
  }
  assert.equal(calls, 3);
});

test("history API rate limits are not retried by the fixed preparation pipeline", async (context) => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    calls++;
    return Response.json({}, { status: 429, headers: { "Retry-After": "0" } });
  });
  const items = await build_im_contexts(
    config,
    message,
    "bf_fixture",
    new AbortController().signal,
    {
      initialSession: false,
      historyGap: planHistoryGap(104, metadata(), "epoch")
    }
  );
  assert.equal(calls, 1);
  assert.equal(items.find((item) => item.name === "history-gap").payload.status, "unavailable");
});

test("review regression: DM cold history retains its original timeout and HTTP 429 retry", async (context) => {
  const deadlines = [];
  context.mock.method(AbortSignal, "timeout", (duration) => {
    deadlines.push(duration);
    return new AbortController().signal;
  });
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return Response.json({}, { status: 429, headers: { "Retry-After": "0" } });
    return Response.json({
      more: 0,
      messages: [
        {
          message_id: "103",
          message_seq: 103,
          from_uid: "peer",
          payload: { type: 1, content: "DM background" }
        }
      ]
    });
  });
  const items = await build_im_contexts(
    config,
    { ...message, channelId: "peer", channelType: 1 },
    "bf_fixture",
    new AbortController().signal,
    { initialSession: true }
  );
  assert.equal(calls, 2);
  assert.ok(deadlines.includes(30_000));
  assert.equal(deadlines.includes(10_000), false);
  assert.equal(items.find((item) => item.name === "history").payload.text, "peer：DM background");
});
