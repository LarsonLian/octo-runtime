import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { ExtraPlugins, readExtraDirectory } from "../packages/octo-runtime-daemon/dist/index.js";
import load, { name } from "../packages/octo-runtime-webui-extra/dist/index.js";
import { SessionStore } from "../packages/octo-runtime-webui-extra/dist/store.js";
import { runCli } from "../apps/cli/dist/main.js";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function setup(t, host = {}) {
  const home = await mkdtemp(join(tmpdir(), "octo-webui-"));
  const port = await freePort();
  const extras = new ExtraPlugins(
    [
      {
        name,
        config: { port, sessionStorePath: join(home, "sessions.json"), defaultProjectPath: home },
        load: async () => ({ name, default: load })
      }
    ],
    host
  );
  t.after(async () => {
    await extras.close();
    await rm(home, { recursive: true, force: true });
  });
  await extras.loadConfigured();
  assert.equal((await extras.inspect(name)).listening, true);
  const origin = `http://127.0.0.1:${port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Octo Runtime/);
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const boot = await fetch(origin + "/api/bootstrap", { headers: { cookie } }).then((r) =>
    r.json()
  );
  const request = (path, method = "GET", body, headers = {}) =>
    fetch(origin + "/api" + path, {
      method,
      headers: {
        cookie,
        Origin: origin,
        "X-Webui-Token": boot.token,
        "Content-Type": "application/json",
        ...headers
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  return { home, port, extras, request, origin };
}
test("local browser boundary, adapter discovery, private JSON, revision fencing and bounded LRU", async (t) => {
  const { request, home, origin } = await setup(t, {
    list: async () => [{ type: "codex", available: true, providerPath: "/private/provider" }]
  });
  assert.deepEqual(await request("/adapters").then((r) => r.json()), [
    { providerType: "codex", available: true }
  ]);
  assert.equal((await fetch(origin + "/api/sessions")).status, 401);
  assert.equal(
    (await request("/sessions", "POST", { projectPath: home }, { Origin: "https://evil.example" }))
      .status,
    403
  );
  assert.equal((await fetch(origin, { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  let first;
  for (let n = 0; n < 101; n++) {
    const response = await request("/sessions", "POST", { projectPath: home });
    assert.equal(response.status, 201);
    const session = await response.json();
    first ??= session.id;
  }
  const sessions = await request("/sessions").then((r) => r.json());
  assert.equal(sessions.length, 100);
  assert(!sessions.some((s) => s.id === first));
  const id = sessions[0].id;
  const detail = await request(`/sessions/${id}`).then((r) => r.json());
  const patch = {
    ...detail,
    title: "test",
    messages: [],
    providerSession: { sessionId: "opaque", extension: { key: "value" } }
  };
  assert.equal((await request(`/sessions/${id}`, "PATCH", patch)).status, 200);
  assert.equal((await request(`/sessions/${id}`, "PATCH", patch)).status, 409);
  assert.deepEqual(
    (await request(`/sessions/${id}`).then((r) => r.json())).providerSession,
    patch.providerSession
  );
  assert.equal((await stat(join(home, "sessions.json"))).mode & 0o777, 0o600);
  const restored = new SessionStore(join(home, "sessions.json"));
  await restored.open();
  assert.equal(restored.records.length, 100);
  await request(`/sessions/${id}`, "DELETE");
  assert.equal((await request(`/sessions/${id}`, "PATCH", { ...patch, revision: 1 })).status, 404);
  await request("/sessions", "DELETE");
  assert.equal((await request("/sessions").then((r) => r.json())).length, 0);
});
test("canonical SSE passes unchanged and cleanup waits for active invocation cancellation", async (t) => {
  let received,
    aborted = false,
    responded;
  const event = {
    protocolVersion: 2,
    type: "message.delta",
    payload: { channel: "final", text: "hello" }
  };
  const host = {
    list: async () => [],
    async *invoke(input, { signal }) {
      received = input;
      yield event;
      await new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true }
        )
      );
    },
    async cancel() {
      return { cancelled: true };
    },
    async respondInteraction(id, response) {
      responded = { id, response };
    }
  };
  const { request, home, extras } = await setup(t, host);
  const session = await request("/sessions", "POST", { projectPath: home }).then((r) => r.json());
  const id = randomUUID();
  const input = {
    inputs: [{ type: "text", text: "hello" }],
    contexts: { schema: "octo.context-envelope/v3", items: [] },
    sessionId: session.id,
    invocationId: id,
    runId: id,
    protocol_mode: "canonical",
    workdir: home
  };
  const response = await request("/invoke", "POST", input);
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, `data: ${JSON.stringify(event)}\n\n`);
  assert.deepEqual(received, input);
  assert.equal(
    (await request("/invoke", "POST", { ...input, invocationId: randomUUID() })).status,
    409
  );
  await request(`/invocations/${id}/respond`, "POST", {
    interactionId: "interaction",
    outcome: "accepted"
  });
  assert.equal(responded.id, id);
  await request(`/sessions/${session.id}`, "DELETE");
  assert.equal(aborted, true);
  assert.equal((await request(`/sessions/${session.id}`)).status, 404);
  await reader.cancel().catch(() => {});
  await extras.unload(name);
  assert.equal(extras.status[name].phase, "disposed");
});
test("CLI extraset retains explicit WebUI config and loads only the selected extra", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "octo-webui-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const value = {
    module: "@mininglamp-oss/octo-runtime-webui-extra",
    enabled: true,
    config: { port: 13888, sessionStorePath: join(home, "extras/webui/sessions.json") }
  };
  await runCli(["--home", home, "extraset", "webui"], {
    input: Readable.from([JSON.stringify(value)]),
    output: () => {}
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(home, "extras/webui/config.json"), "utf8")),
    value
  );
  assert.equal((await readExtraDirectory(join(home, "extras")))[0].name, "webui");
});

test('WebUI status reports occupied port and corrupted JSON without overwriting data',async t=>{
  const {port,home}=await setup(t);
  const path=join(home,'broken.json');await writeFile(path,'{broken');
  const bad=new ExtraPlugins([{name,config:{port:await freePort(),sessionStorePath:path},load:async()=>({name,default:load})}],{});
  const occupied=new ExtraPlugins([{name,config:{port,sessionStorePath:join(home,'other.json')},load:async()=>({name,default:load})}],{});
  t.after(async()=>{await bad.close();await occupied.close();});
  await bad.loadConfigured();assert.deepEqual((await bad.inspect(name)).errors,['WEBUI_STORE_INVALID']);assert.equal(await readFile(path,'utf8'),'{broken');
  await occupied.loadConfigured();assert.deepEqual((await occupied.inspect(name)).errors,['WEBUI_ADDRESS_IN_USE']);
});
