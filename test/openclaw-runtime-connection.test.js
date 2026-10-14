import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  configureOpenClawConnection,
  loadLocalOpenClawGateway,
  createOpenClawAdapter
} from "@mininglamp-oss/octo-harness-adapter-openclaw";
import {
  AdapterHost,
  AdapterHostRpcClient,
  AdapterHostRpcServer
} from "@mininglamp-oss/octo-harness-adapter-host";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "oh-connections-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("connection sources are persisted per Runtime, with precedence and fail-closed behavior", async (t) => {
  const root = await fixture(t);
  const one = join(root, "one"),
    two = join(root, "two"),
    source = join(root, "native");
  await mkdir(source);
  await writeFile(
    join(source, "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "home-token" }, port: 19100 } })
  );
  await configureOpenClawConnection(
    one,
    { openclawHome: source },
    { OPENCLAW_GATEWAY_URL: "invalid", OPENCLAW_GATEWAY_TOKEN: "ignored" }
  );
  const connection = await configureOpenClawConnection(
    two,
    {},
    { OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19101", OPENCLAW_GATEWAY_TOKEN: "manual-token" }
  );
  const [a, b] = await Promise.all([loadLocalOpenClawGateway(one), loadLocalOpenClawGateway(two)]);
  assert.equal(a.token, "home-token");
  assert.equal(b.token, "manual-token");
  assert.notEqual(a.device.deviceId, b.device.deviceId);
  assert.equal(
    (await configureOpenClawConnection(two, {}, { OPENCLAW_HOME: source })).source,
    "gateway"
  );
  assert.equal((await loadLocalOpenClawGateway(two)).token, "manual-token");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(two, connection.credential_ref))).mode & 0o777, 0o600);
    assert.equal((await stat(join(two, "credentials/openclaw-device.json"))).mode & 0o777, 0o600);
  }
  assert.equal(
    (await readFile(join(two, "adapters/openclaw/connection.json"), "utf8")).includes(
      "manual-token"
    ),
    false
  );
  await configureOpenClawConnection(one, { url: "ws://127.0.0.1:19102", token: "new-token" });
  const changed = await loadLocalOpenClawGateway(one);
  assert.equal(changed.token, "new-token");
  assert.deepEqual(changed.device, a.device);
  await rm(join(two, connection.credential_ref));
  await assert.rejects(loadLocalOpenClawGateway(two), /gateway_credential_invalid/);
  await assert.rejects(
    configureOpenClawConnection(two, { url: "ws://127.0.0.1:19103" }),
    /gateway_url_and_token_required/
  );
  await assert.rejects(
    configureOpenClawConnection(two, {
      openclawHome: source,
      url: "ws://127.0.0.1:19103",
      token: "x"
    }),
    /connection_sources_conflict/
  );
  await assert.rejects(
    configureOpenClawConnection(two, { url: "ws://remote.example:18789", token: "x" }),
    /remote_gateway_requires_wss/
  );
});

test("shared Host probes and invokes each Runtime connection and uses only the Context Agent target", async (t) => {
  const root = await fixture(t);
  const roots = [join(root, "a"), join(root, "b")];
  await Promise.all(
    roots.map((dir, i) =>
      configureOpenClawConnection(dir, { url: `ws://127.0.0.1:${19200 + i}`, token: `token-${i}` })
    )
  );
  const observed = [];
  const adapter = createOpenClawAdapter({
    clientFactory: (options) => {
      const record = { url: options.url, token: options.token, methods: [] };
      observed.push(record);
      return {
        async connect() {
          return {
            protocol: 4,
            features: {
              methods: [
                "agents.list",
                "sessions.create",
                "sessions.messages.subscribe",
                "agent",
                "agent.wait",
                "sessions.abort"
              ],
              events: ["agent"]
            }
          };
        },
        onEvent() {
          return () => {};
        },
        async close() {},
        async request(method, params) {
          record.methods.push({ method, params });
          if (method === "agents.list") return { agents: [{ id: "researcher" }] };
          if (method === "sessions.create") return { key: params.key };
          if (method === "agent") return { status: "ok", result: { payloads: [{ text: "done" }] } };
          if (method === "agent.wait") return { status: "ok" };
          return {};
        }
      };
    }
  });
  const host = new AdapterHost();
  host.register(adapter);
  const requests = new PassThrough(),
    responses = new PassThrough();
  const server = new AdapterHostRpcServer({ host, input: requests, output: responses });
  server.listen(requests);
  const client = new AdapterHostRpcClient({ input: responses, output: requests });
  t.after(() => {
    client.close();
    requests.destroy();
    responses.destroy();
  });
  const configurations = roots.map((dir) => ({ providerOptions: { OPENCLAW_RUNTIME_ROOT: dir } }));
  const listings = await Promise.all(
    configurations.map((config) => client.list({ openclaw: config }))
  );
  assert.ok(listings.every((list) => list[0].available)); // no main Agent exists
  assert.deepEqual(new Set(observed.map((value) => value.token)), new Set(["token-0", "token-1"]));
  await Promise.all(configurations.map((config) => client.probe("openclaw", config)));
  // Rotation must be picked up without restarting the shared Host.
  await configureOpenClawConnection(roots[1], { url: "ws://127.0.0.1:19300", token: "rotated" });
  const request = {
    protocolVersion: 2,
    invocationId: "invoke-b",
    runId: "run-b",
    agentSessionId: "s",
    workdir: "",
    prompt: "work",
    modelInput: "work",
    controlInstructions: "",
    approvalMode: "full_access",
    agentSource: "preset",
    context: { schema: "octo.context-envelope/v3", items: [] },
    agentConfig: {
      providerAgentId: "researcher",
      providerOptions: {
        ...configurations[1].providerOptions,
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:19999",
        OPENCLAW_GATEWAY_TOKEN: "must-not-win"
      }
    }
  };
  const events = [];
  for await (const event of client.invoke("openclaw", request, { protocolMode: "canonical" }))
    events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
  const call = observed.at(-1);
  assert.equal(call.token, "rotated");
  assert.equal(call.url, "ws://127.0.0.1:19300/");
  assert.equal(call.methods.find((entry) => entry.method === "agent").params.agentId, "researcher");
  assert.equal(
    call.methods.some((entry) => ["agents.create", "config.patch"].includes(entry.method)),
    false
  );
});
