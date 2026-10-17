import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDaemonRuntime } from "../packages/octo-runtime-daemon/dist/index.js";
import * as gateway from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";
import {
  fetchBotGroups,
  getChannelMessages
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";

// .octospec/tasks/channel-group-admission/plan.md：仅在既有 im-test QA 群验证真实入口。
// 临时 Home 和独立测试 Adapter 不接触用户 Runtime；凭据不进参数、输出或模型。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "Set protected QA account file path");
const accounts = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .map((block) => {
    const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: value("Bot ID"), token: value("Bot Token"), api: value("API Server") };
  })
  .filter((account) => account.token?.startsWith("bf_"));
const [receiver, sender] = accounts;
assert.ok(receiver && sender, "Two QA Bots are required");
for (const account of [receiver, sender]) {
  assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
  const identity = await verifyBotIdentity(account.api, account.token, AbortSignal.timeout(15000));
  assert.equal(identity.bot_uid, account.id);
}
const execute = promisify(execFile);
async function cli(account, args, body) {
  const env = {
    ...process.env,
    OCTO_BOT_TOKEN: account.token,
    OCTO_API_BASE_URL: "https://im-test.deepminer.com.cn"
  };
  for (const name of ["OCTO_BOT_ID", "OCTO_PROFILE", "OCTO_CREDENTIAL_MODE", "OCTO_SPACE_ID"])
    delete env[name];
  try {
    const { stdout } = await execute(
      "octo-cli",
      [...args, ...(body ? ["--data", JSON.stringify(body)] : [])],
      { env, timeout: 15000, maxBuffer: 1 << 20 }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.identity.bot_kind, "user_bot");
    return result.data;
  } catch {
    throw new Error(`QA CLI failed: ${args.slice(0, 2).join(" ")}`);
  }
}
await cli(receiver, ["config", "show"]);
await cli(sender, ["config", "show"]);
const receiverGroups = await fetchBotGroups({ apiUrl: receiver.api, botToken: receiver.token });
const senderGroups = await fetchBotGroups({ apiUrl: sender.api, botToken: sender.token });
const group = receiverGroups.find(
  (value) =>
    value.name.startsWith("Channel_QA_") &&
    senderGroups.some((other) => other.group_no === value.group_no)
);
assert.ok(group, "An existing shared Channel_QA_ group is required");
const threads = await cli(receiver, ["thread", "list", group.group_no]);
const candidates = Array.isArray(threads) ? threads : (threads.threads ?? threads.items ?? []);
const thread = candidates.find((value) => value.name === "Channel_QA_topic" && value.short_id);
assert.ok(thread, "An existing Channel_QA_topic is required");
const topicId = `${group.group_no}____${thread.short_id}`;
const root = await mkdtemp("/tmp/octo-admit-");
const entrypoint = fileURLToPath(
  new URL("../test/fixtures/channel-admission-host.js", import.meta.url)
);
const runtimeCli = fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));
const gatewayPath = fileURLToPath(
  new URL("../packages/octo-runtime-extra-channel-gateway/dist/extra.js", import.meta.url)
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function wait(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`QA timeout: ${label}`);
}
async function localCli(home, args, input) {
  const child = spawn(process.execPath, [runtimeCli, "--home", home, ...args], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.resume();
  child.stdin.end(input ? JSON.stringify(input) : undefined);
  const [code] = await once(child, "close");
  assert.equal(code, 0, `Runtime CLI failed: ${args[0]}`);
  return JSON.parse(stdout);
}
const report = {
  environment: "im-test",
  realWebSocket: true,
  independentAdapterHost: true,
  modelCalls: 0,
  senderExplicitlyAuthorized: true,
  sentMessages: 0,
  entries: []
};
try {
  for (const mode of ["cli", "sdk"]) {
    const home = await mkdtemp(join(root, `${mode}-`));
    const trace = join(home, "admission-trace.jsonl");
    const config = {
      bot_id: receiver.id,
      api_url: receiver.api,
      bf_token: receiver.token,
      allowed_sender_ids: [sender.id],
      cards: false,
      typing: false,
      run_timeout_ms: 15000,
      adapter: { adapter_type: "test", workdir: home }
    };
    const calls = async () =>
      (
        await readFile(trace, "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        })
      )
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    let processHandle, runtime;
    let contextLoads = 0;
    const status = async () =>
      mode === "sdk"
        ? runtime.extraStatus("channel-gateway")
        : (await localCli(home, ["status"])).extras?.["channel-gateway"]?.status;
    const ready = async () => {
      const value = await status().catch(() => undefined);
      return value?.bots?.[0]?.state === "online";
    };
    const send = async (label, channelId = group.group_no, channelType = 2, mention = true) => {
      const marker = `GROUP_ADMISSION_QA_${mode}_${label}_${Date.now()}`;
      await cli(sender, ["message", "send"], {
        channel_id: channelId,
        channel_type: channelType,
        payload: {
          type: 1,
          content: marker,
          ...(mention ? { mention: { uids: [receiver.id] } } : {})
        }
      });
      report.sentMessages++;
      return marker;
    };
    const replied = async (marker, channelId = group.group_no, channelType = 2) => {
      await wait(
        async () =>
          (
            await getChannelMessages({
              apiUrl: receiver.api,
              botToken: receiver.token,
              channelId,
              channelType,
              limit: 30
            })
          ).some(
            (value) =>
              value.from_uid === receiver.id && value.content === `GROUP_ADMISSION_REPLY:${marker}`
          ),
        `${mode} original-channel reply`
      );
      assert.equal((await calls()).filter((value) => value.marker === marker).length, 1);
    };
    try {
      if (mode === "cli") {
        await localCli(home, ["extraset", "channel-gateway"], {
          module: gatewayPath,
          config: { bots: [config] }
        });
        processHandle = spawn(process.execPath, [runtimeCli, "--home", home, "daemon", "run"], {
          detached: true,
          env: {
            ...process.env,
            OCTO_RUNTIME_ADAPTER_HOST: entrypoint,
            OPENCLAW_HOME: join(home, "unused-openclaw")
          },
          stdio: "ignore"
        });
      } else {
        runtime = createDaemonRuntime({
          appId: "channel-group-admission-qa",
          home,
          distribution: { adapterHostEntrypoint: entrypoint },
          healthPollIntervalMs: 50
        });
        await runtime.startAccount({
          subject: { type: "user", id: "qa" },
          tenants: [{ id: "qa" }]
        });
        await runtime.loadExtra(
          gateway,
          { bots: [config] },
          {
            async loadContexts() {
              contextLoads++;
              return [];
            }
          }
        );
      }
      await wait(ready, `${mode} Bot online`);
      const unmentioned = await send("no_mention", group.group_no, 2, false);
      const groupMarker = await send("default");
      await replied(groupMarker);
      const topicMarker = await send("topic", topicId, 5);
      await replied(topicMarker, topicId, 5);
      assert.equal(
        (await calls()).some((value) => value.marker === unmentioned),
        false
      );
      const entry = {
        mode,
        defaultGroupReply: true,
        defaultTopicReply: true,
        noMentionRejected: true
      };
      if (mode === "sdk") {
        for (const [label, overrides] of [
          ["null", { group_ids: null }],
          ["empty", { group_ids: [] }],
          ["listed", { group_ids: [group.group_no] }]
        ]) {
          await runtime.unloadExtra("channel-gateway");
          await runtime.loadExtra(
            gateway,
            { bots: [{ ...config, ...overrides }] },
            {
              async loadContexts() {
                contextLoads++;
                return [];
              }
            }
          );
          await wait(ready, `sdk ${label} Bot online`);
          await replied(await send(label));
        }
        for (const overrides of [
          { groups_enabled: false },
          { group_ids: ["outside-this-qa-group"] },
          { allowed_sender_ids: [] }
        ]) {
          await runtime.unloadExtra("channel-gateway");
          await runtime.loadExtra(gateway, { bots: [{ ...config, ...overrides }] }, {});
          await wait(ready, "sdk restricted Bot online");
          const before = (await calls()).length;
          await send("rejected");
          await delay(1000);
          assert.equal((await calls()).length, before);
        }
        assert.equal(contextLoads, 5);
        Object.assign(entry, {
          nullAndEmptyReply: true,
          explicitGroupReply: true,
          disabledAndOutsideGroupRejected: true,
          unauthorizedSenderRejected: true,
          asyncContextLoads: contextLoads
        });
      }
      report.entries.push(entry);
      console.error(`verified: ${mode} actual group/topic receive, execute and reply`);
    } finally {
      await runtime?.stop();
      if (processHandle?.pid) {
        const closed = once(processHandle, "close");
        try {
          process.kill(-processHandle.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
        const timer = setTimeout(() => {
          try {
            process.kill(-processHandle.pid, "SIGKILL");
          } catch {}
        }, 5000);
        await closed;
        clearTimeout(timer);
      }
    }
  }
  console.log(JSON.stringify({ ...report, passed: true }));
} finally {
  await rm(root, { recursive: true, force: true });
}
