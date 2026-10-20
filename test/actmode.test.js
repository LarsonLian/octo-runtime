import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertContextEnvelope,
  assertExecutionEvidence,
  resolveContextConfiguration,
  contextActmode
} from "../packages/octo-runtime-protocol/dist/index.js";
import { assertJsonValue } from "../packages/octo-runtime-protocol/dist/context.js";
import { prepareInvokeInput } from "../packages/octo-runtime-executor-core/dist/invoke-input.js";
import { renderModelContexts } from "../packages/octo-runtime-executor-core/dist/model-input.js";
import { createCodexAdapter } from "../packages/octo-runtime-adapter-codex/dist/index.js";
import { createClaudeCodeAdapter } from "../packages/octo-runtime-adapter-claude-code/dist/index.js";
import { createAcpAdapter } from "../packages/octo-runtime-adapter-acp/dist/index.js";
import { invokeRequest, contextEnvelope } from "./runtime-fixture.js";

const fixture = fileURLToPath(new URL("../test-support/fake-actmode.mjs", import.meta.url));
const contexts = (mode) =>
  contextEnvelope(
    mode === undefined ? [] : [{ namespace: "octo.execution", name: "actmode", payload: { mode } }]
  );
const collect = async (source) => {
  const events = [];
  for await (const event of source) events.push(event);
  return events;
};

test("actmode validates explicit values, applies configuration ownership and never renders as model text", () => {
  for (const mode of ["plan", "default"]) {
    assertContextEnvelope(contexts(mode));
    const { request } = prepareInvokeInput({
      inputs: [{ type: "text", text: "test" }],
      contexts: contexts(mode)
    });
    assert.equal(contextActmode(request.context), mode);
    assert.equal(renderModelContexts(request.context), "");
  }
  assert.equal(
    contextActmode(
      prepareInvokeInput({ inputs: [{ type: "text", text: "test" }], contexts: contexts() }).request
        .context
    ),
    undefined
  );
  for (const mode of [null, "", "PLAN", "execute", false, {}])
    assert.throws(() => assertContextEnvelope(contexts(mode)));
  assert.throws(
    () =>
      assertContextEnvelope(
        contextEnvelope([...contexts("plan").items, ...contexts("default").items])
      ),
    /DUPLICATED/
  );
  assert.equal(
    contextActmode(
      resolveContextConfiguration(
        { defaults: contexts("plan"), mandatory: contexts() },
        contexts("default")
      )
    ),
    "default"
  );
  assert.equal(
    contextActmode(
      resolveContextConfiguration(
        { defaults: contexts(), mandatory: contexts("plan") },
        contexts("default")
      )
    ),
    "plan"
  );
  assert.throws(() =>
    assertExecutionEvidence({
      actmode: {
        requested: "plan",
        effective: "plan",
        status: "fallback",
        reason: "provider_unsupported"
      }
    })
  );
});

for (const provider of ["codex", "claude-code"])
  for (const mode of [undefined, "default", "plan"]) {
    test(
      `${provider} maps only explicit actmode=${mode} in canonical and native`,
      { timeout: 10000 },
      async () => {
        const directory = await mkdtemp(join(tmpdir(), "octo-actmode-"));
        try {
          for (const protocolMode of ["canonical", "native"]) {
            const log = join(directory, protocolMode);
            const options = [fixture, "--log", log];
            const adapter =
              provider === "codex"
                ? createCodexAdapter({ command: process.execPath, appServerArgs: options })
                : createClaudeCodeAdapter({
                    command: process.execPath,
                    commandArgsPrefix: options
                  });
            const req = invokeRequest({
              context: contexts(mode),
              signal: AbortSignal.timeout(8000)
            });
            const snapshot = structuredClone(req.context);
            const events = await collect(adapter.invoke(req, { protocolMode }));
            const evidence = events.find(
              (event) => event.type === "execution.update" || event.control?.name === "execution"
            );
            assert.equal(Boolean(evidence), mode !== undefined);
            if (evidence)
              assert.deepEqual((evidence.payload ?? evidence.control.payload).actmode, {
                requested: mode,
                effective: mode,
                status: "applied",
                nativeMode: mode
              });
            const lines = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
            if (provider === "codex") {
              const turn = lines.find((line) => line.method === "turn/start");
              assert.equal(turn.params.collaborationMode?.mode, mode);
              assert.equal(
                lines.some((line) => line.method === "collaborationMode/list"),
                mode !== undefined
              );
              if (mode)
                assert.equal(turn.params.collaborationMode.settings.model, "provider-chosen-model");
            } else {
              const args = lines[0].args;
              assert.equal(
                args[args.indexOf("--permission-mode") + 1],
                mode === "plan" ? "plan" : "default"
              );
              assert.equal(args.includes("--dangerously-skip-permissions"), false);
            }
            assert.deepEqual(req.context, snapshot);
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    );
  }

test(
  "Codex falls back only for advertised unsupported plan; provider failure does not restart turn",
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-actmode-fallback-"));
    try {
      for (const fail of [false, true]) {
        const log = join(directory, String(fail));
        const adapter = createCodexAdapter({
          command: process.execPath,
          appServerArgs: [fixture, "--log", log, "--unsupported", ...(fail ? ["--fail-turn"] : [])]
        });
        const events = await collect(
          adapter.invoke(
            invokeRequest({ context: contexts("plan"), signal: AbortSignal.timeout(8000) })
          )
        );
        const evidence = events.find((e) => e.type === "execution.update");
        if (fail) {
          assert.equal(evidence, undefined);
          assert.equal(events.at(-1).type, "run.failed");
        } else
          assert.deepEqual(evidence.payload.actmode, {
            requested: "plan",
            effective: "default",
            status: "fallback",
            nativeMode: "default",
            reason: "provider_unsupported"
          });
        const lines = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(lines.filter((line) => line.method === "turn/start").length, 1);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

for (const modern of [true, false])
  test(`ACP ${modern ? "configOptions" : "modes"} maps explicit input, omission performs no setting`, async () => {
    for (const mode of [undefined, "default", "plan"]) {
      const calls = [];
      const client = {
        initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
        reserveRequestId: () => calls.length + 1,
        request: async (method, params) => {
          calls.push({ method, params });
          return method === "session/new"
            ? {
                sessionId: "acp-actmode",
                ...(modern
                  ? {
                      configOptions: [
                        {
                          id: "mode",
                          category: "mode",
                          currentValue: "default",
                          options: [{ value: "default" }, { value: "plan" }]
                        }
                      ]
                    }
                  : {
                      modes: {
                        currentModeId: "default",
                        availableModes: [{ id: "default" }, { id: "plan" }]
                      }
                    })
              }
            : {};
        },
        async *prompt() {
          yield { sessionUpdate: "agent_message_chunk", content: { text: "MODE_OK" } };
          yield { type: "usage", usage: { inputTokens: 1 } };
          yield { type: "prompt_result", stopReason: "end_turn" };
        },
        close: async () => {},
        cancel: () => {}
      };
      const adapter = createAcpAdapter(
        { type: "fixture", provider: "fixture", command: "fixture" },
        { acpClientFactory: () => client }
      );
      const events = await collect(adapter.invoke(invokeRequest({ context: contexts(mode) })));
      const settings = calls.filter((call) => call.method.startsWith("session/set_"));
      assert.equal(settings.length, mode === "plan" ? 1 : 0);
      if (mode === "plan")
        assert.deepEqual(
          settings[0],
          modern
            ? {
                method: "session/set_config_option",
                params: { sessionId: "acp-actmode", configId: "mode", value: "plan" }
              }
            : { method: "session/set_mode", params: { sessionId: "acp-actmode", modeId: "plan" } }
        );
      assert.equal(
        events.some((event) => event.type === "execution.update"),
        mode !== undefined
      );
      assert.equal(events.at(-1).type, "run.completed");
      for (const event of events) assertJsonValue(event);
    }
  });

test("ACP only falls back for advertised unsupported modes; setter errors do not prompt", async () => {
  for (const fail of [false, true]) {
    let prompted = false;
    const client = {
      initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
      reserveRequestId: () => 1,
      request: async (method) => {
        if (method === "session/new")
          return {
            sessionId: "fallback-session",
            modes: { currentModeId: "other", availableModes: [{ id: "default" }] }
          };
        if (fail) throw new Error("SET_MODE_FAILED");
        return {};
      },
      async *prompt() {
        prompted = true;
        yield { type: "prompt_result", stopReason: "end_turn" };
      },
      close: async () => {},
      cancel: () => {}
    };
    const adapter = createAcpAdapter(
      { type: "fixture", provider: "fixture", command: "fixture" },
      { acpClientFactory: () => client }
    );
    const events = [];
    const execution = async () => {
      for await (const event of adapter.invoke(invokeRequest({ context: contexts("plan") })))
        events.push(event);
    };
    if (fail) await assert.rejects(execution, /SET_MODE_FAILED/);
    else await execution();
    const evidence = events.find((event) => event.type === "execution.update");
    assert.equal(prompted, !fail);
    if (fail) {
      assert.equal(evidence, undefined);
    } else {
      assert.deepEqual(evidence.payload.actmode, {
        requested: "plan",
        effective: "default",
        nativeMode: "default",
        status: "fallback",
        reason: "provider_unsupported"
      });
    }
  }
});
