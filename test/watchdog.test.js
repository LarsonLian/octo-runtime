import test from "node:test";
import assert from "node:assert/strict";
import { InvocationWatchdog } from "../packages/octo-harness-adapter-host/dist/watchdog.js";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { assertRuntimeLimits } from "@mininglamp-oss/octo-harness-protocol";

function fixture(limits = {}, native = true) {
  let now = 0;
  const timers = new Map();
  let id = 0;
  const clock = {
    now: () => now,
    schedule(fn, delay) { const key = ++id; timers.set(key, { fn, at: now + delay }); return () => timers.delete(key); }
  };
  const controller = new AbortController();
  const records = [];
  const watchdog = new InvocationWatchdog(limits, controller, native, r => records.push(r), clock);
  return {
    watchdog, controller, records, timers,
    tick(ms) {
      const end = now + ms;
      while (true) {
        const first = [...timers.entries()].sort((a,b) => a[1].at-b[1].at)[0];
        if (!first || first[1].at > end) break;
        now = first[1].at; timers.delete(first[0]); first[1].fn();
      }
      now = end;
    }
  };
}
const started = { kind: "turn_started", method: "turn_start" };
const progress = { kind: "turn_progress", method: "text_delta" };

test("late user cancellation cannot replace a terminal during cleanup", { timeout: 2000 }, async () => {
  const host = new AdapterHost();
  let release, markCleaning;
  const cleaning = new Promise(resolve => { markCleaning = resolve; });
  const cleanup = new Promise(resolve => { release = resolve; });
  host.register({ metadata: { type: "terminal-race", capabilities: ["react"], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke() {
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
    markCleaning(); await cleanup;
  } });
  const stream = host.invoke("terminal-race", { ...request, invocationId: "terminal-race" });
  const pending = (async () => { while (true) { const next = await stream.next(); if (next.done || next.value.type.startsWith("run.")) return next; } })();
  await Promise.race([cleaning, pending.then(() => assert.fail("terminal delivered before cleanup"))]);
  assert.equal(host.cancel("terminal-race"), false);
  release();
  assert.equal((await pending).value.type, "run.completed");
  await stream.next();
});

test("session and usage records cannot escape startup deadline", () => {
  const f = fixture({ firstFrameTimeoutMs: 100 });
  f.tick(50); f.watchdog.canonical({ protocolVersion: 2, type: "session.update", payload: {} });
  f.watchdog.canonical({ protocolVersion: 2, type: "usage.update", payload: {} });
  f.tick(50);
  assert.equal(f.controller.signal.reason.timeoutReason, "first_frame");
});

test("terminal freezes timers but completion metrics wait for cleanup outcome", () => {
  const f = fixture(); f.watchdog.activity(started); f.tick(10);
  f.watchdog.canonical({ protocolVersion: 2, type: "run.completed", payload: {} });
  assert.equal(f.records.filter(x => x.event === "finished").length, 0);
  f.tick(10000); f.watchdog.finish("failed"); f.watchdog.finish("completed");
  const records = f.records.filter(x => x.event === "finished");
  assert.equal(records.length, 1);
  assert.equal(records[0].data.outcome, "failed");
  assert.equal(records[0].data.elapsedMs, 10);
});

test("run defaults to three hours and explicit limits may shorten or extend it", () => {
  for (const [limits, deadline] of [[{},10_800_000],[{runTimeoutMs:7_200_000},7_200_000],[{runTimeoutMs:21_600_000},21_600_000]]) {
    const f=fixture({...limits,modelIdlePolicy:"observe"}); f.watchdog.activity(started);
    f.tick(deadline-1); assert.equal(f.controller.signal.aborted,false);
    f.watchdog.activity(progress);
    f.tick(1); assert.equal(f.controller.signal.reason.timeoutMs,deadline);
    assert.equal(f.controller.signal.reason.timeoutReason,"run_deadline");
  }
});

test("default model budget tolerates 120 seconds and expires exactly at 300 seconds", () => {
  const f = fixture(); f.watchdog.activity(started);
  f.tick(120_000); assert.equal(f.controller.signal.aborted, false);
  assert.equal(f.records.filter(x=>x.event === "model_silence").length, 1);
  f.tick(179_999); assert.equal(f.controller.signal.aborted, false);
  f.tick(1); assert.equal(f.controller.signal.reason.timeoutReason, "model_silence");
  assert.equal(f.controller.signal.reason.timeoutMs, 300_000);
  assert.equal(f.timers.size, 0);
});

test("native progress rearms one timer, while transport and retries cannot hide model silence", () => {
  const f = fixture({ modelIdleTimeoutMs: 1000, modelIdleWarningMs: 500 });
  f.watchdog.activity(started); f.tick(600); f.watchdog.activity(progress);
  assert.equal(f.records.filter(x=>x.event === "progress_resumed").length, 1);
  for(let i=0;i<9;i++) {
    f.tick(100); f.watchdog.activity({ kind:"transport_response", method:"rpc_response" });
    f.watchdog.activity({ kind:"retry_notice", method:"retry" });
    assert.equal(f.timers.size, 1);
  }
  f.tick(100); assert.equal(f.controller.signal.reason.timeoutReason, "model_silence");
  assert.equal(f.controller.signal.reason.evidence.retryCount, 9);
});

test("model observe retains hard run deadline despite progress and warnings", () => {
  const f = fixture({ modelIdlePolicy:"observe", modelIdleWarningMs:100, modelIdleTimeoutMs:200, runTimeoutMs:1000 });
  f.watchdog.activity(started); f.tick(900);
  assert.equal(f.controller.signal.aborted, false);
  assert.equal(f.records.filter(x=>x.event === "model_silence").length, 1);
  f.watchdog.activity(progress); f.tick(100);
  assert.equal(f.controller.signal.reason.timeoutStage, "run_deadline");
  assert.equal(f.controller.signal.reason.timeoutMs, 1000);
});

test("tool idle is isolated per tool and output cannot extend wall deadline", () => {
  const f = fixture({ toolTimeoutMs:500, toolWallTimeoutMs:1000 });
  f.watchdog.canonical({ protocolVersion: 2, type:"tool_call.create", payload:{ status: "running",id:"a"} });
  f.watchdog.canonical({ protocolVersion: 2, type:"tool_call.create", payload:{ status: "running",id:"b"} });
  f.tick(400); f.watchdog.activity({kind:"turn_progress",method:"tool_delta",toolCallId:"a"});
  f.tick(100); assert.equal(f.controller.signal.reason.timeoutReason, "tool_idle");
  const g = fixture({ toolTimeoutMs:500, toolWallTimeoutMs:1000 });
  g.watchdog.canonical({ protocolVersion: 2,type:"tool_call.create",payload:{ status: "running",id:"a"}});
  for(let i=0;i<4;i++){g.tick(200);g.watchdog.activity({kind:"turn_progress",method:"tool_delta",toolCallId:"a"});}
  g.tick(200); assert.equal(g.controller.signal.reason.timeoutReason, "tool_deadline");
});

test("last tool closing starts a fresh model budget and terminal cancels timers", () => {
  const f = fixture({ modelIdleTimeoutMs:100, toolTimeoutMs:1000 });
  f.watchdog.canonical({ protocolVersion: 2,type:"tool_call.create",payload:{ status: "running",id:"a"}});
  f.watchdog.canonical({ protocolVersion: 2,type:"tool_call.create",payload:{ status: "running",id:"b"}}); f.tick(500);
  f.watchdog.canonical({ protocolVersion: 2,type:"tool_call.update",payload:{id:"a",status:"completed"}});
  assert.equal(f.watchdog.snapshot().phase,"tool_active");
  f.watchdog.canonical({ protocolVersion: 2,type:"tool_call.update",payload:{id:"b",status:"completed"}});
  f.tick(99); assert.equal(f.controller.signal.aborted,false);
  f.watchdog.canonical({ protocolVersion: 2,type:"run.completed",payload:{}}); f.tick(10_000);
  f.watchdog.activity(progress); assert.equal(f.timers.size,0);
  assert.equal(f.controller.signal.aborted,false);
});

test("native-aware canonical usage does not count as progress; legacy observe remains explicit opt-out", () => {
  const f = fixture({ modelIdleTimeoutMs:100 }); f.watchdog.activity(started);
  f.tick(90); f.watchdog.canonical({ protocolVersion: 2,type:"usage.update",payload:{}}); f.tick(10);
  assert.equal(f.controller.signal.aborted,true);
  const g = fixture({enforcement:"observe"}); g.tick(2_000_000);
  assert.equal(g.controller.signal.aborted,false); g.watchdog.dispose();
});

test("invalid budgets and ambiguous legacy/v2 policies fail closed", () => {
  for(const limits of [{modelIdleTimeoutMs:NaN},{runTimeoutMs:0},{modelIdleTimeoutMs:1.5},{unknown:1},{modelIdlePolicy:"invalid"},{enforcement:"observe",modelIdlePolicy:"observe"}]) {
    assert.throws(()=>assertRuntimeLimits(limits));
  }
  assert.doesNotThrow(()=>assertRuntimeLimits({modelIdlePolicy:"observe",runTimeoutMs:100}));
});

test("approval waiting suspends idle budgets but retains the overall deadline", () => {
  const waiting = fixture({ modelIdleTimeoutMs: 100, toolTimeoutMs: 100, toolWallTimeoutMs: 200, runTimeoutMs: 1000 });
  waiting.watchdog.canonical({ protocolVersion: 2, type: "tool_call.create", payload: { id: "tool", status: "running" } });
  waiting.watchdog.canonical({ protocolVersion: 2, type: "interaction.requested", payload: { interactionId: "approval-a", kind: "approval" } });
  waiting.watchdog.canonical({ protocolVersion: 2, type: "interaction.requested", payload: { interactionId: "approval-b", kind: "approval" } });
  waiting.tick(500);
  assert.equal(waiting.controller.signal.aborted, false);
  assert.equal(waiting.watchdog.snapshot().phase, "waiting_approval");
  waiting.watchdog.canonical({ protocolVersion: 2, type: "interaction.resolved", payload: { interactionId: "approval-a", status: "resolved" } });
  waiting.tick(50);
  assert.equal(waiting.watchdog.snapshot().pendingInteractionCount, 1);
  waiting.watchdog.canonical({ protocolVersion: 2, type: "interaction.resolved", payload: { interactionId: "approval-b", status: "resolved" } });
  waiting.tick(99);
  assert.equal(waiting.controller.signal.aborted, false);
  waiting.tick(1);
  assert.equal(waiting.controller.signal.reason.timeoutReason, "tool_idle");
  const deadline = fixture({ runTimeoutMs: 1000 });
  deadline.watchdog.canonical({ protocolVersion: 2, type: "interaction.requested", payload: { interactionId: "approval", kind: "approval" } });
  deadline.tick(1000);
  assert.equal(deadline.controller.signal.reason.timeoutReason, "run_deadline");
});

const request = { protocolVersion: 2, invocationId:"watchdog-v2",agentSessionKey:"s",runKey:"r",prompt:"p",modelInput:"p",controlInstructions:"",approvalMode:"full_access",context:{schema:"octo.context-envelope/v3",items:[]},agentSource: "provisioned", agentConfig:{},workdir:process.cwd() };
test("host preserves a single pending next during activity and ignores failing diagnostic sinks", async () => {
  let calls=0; let active=0; let peak=0;
  const host = new AdapterHost({diagnosticSink(){throw new Error("sink unavailable");}});
  host.register({metadata:{type:"native",capabilities:["react"],agentSources:["provisioned"],executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access", "activity.turn-progress"]},invoke(req,ctx){
    ctx.reportActivity(started);
    return { [Symbol.asyncIterator](){return this;}, async next(){
      calls++; active++; peak=Math.max(peak,active);
      try {
        if(calls>1)return {done:true};
        for(let i=0;i<4;i++){await new Promise(r=>setTimeout(r,40));ctx.reportActivity(progress);}
        return {done:false,value:{ protocolVersion: 2,type:"run.completed",payload:{}}};
      } finally {active--;}
    }};
  }});
  const events=[];
  for await(const e of host.invoke("native",{...request,runtimeLimits:{modelIdleTimeoutMs:100,modelIdleWarningMs:100,runTimeoutMs:1000}}))events.push(e);
  assert.equal(peak,1); assert.equal(calls,2); assert.equal(events.at(-1).type,"run.completed");
});

test("host hard deadline aborts provider even when its consumer is paused", async () => {
  let signal;
  const host=new AdapterHost();
  host.register({metadata:{type:"paused",capabilities:["react"],agentSources:["provisioned"],executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"]},async *invoke(req){signal=req.signal; yield { protocolVersion: 2,type:"message.create",payload:{}}; await new Promise(()=>{});}});
  const iterator=host.invoke("paused",{...request,runtimeLimits:{runTimeoutMs:100,cancelGraceMs:100,modelIdlePolicy:"observe"}});
  await iterator.next(); await new Promise(r=>setTimeout(r,130));
  assert.equal(signal.aborted,true); assert.equal(signal.reason.timeoutReason,"run_deadline");
  const events=[]; for await(const e of iterator)events.push(e);
  assert.equal(events.at(-1).payload.failure.params.timeoutReason,"run_deadline");
});

test("host bounds cleanup after terminal and timeout wins over provider stopped projection", async () => {
  const host=new AdapterHost();
  host.register({metadata:{type:"cleanup",capabilities:["react"],agentSources:["provisioned"],executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"]},async *invoke(){yield { protocolVersion: 2,type:"run.completed",payload:{}};await new Promise(()=>{});}});
  const events=[];
  for await(const e of host.invoke("cleanup",{...request,runtimeLimits:{cancelGraceMs:100}})) if (!e.type.startsWith("activity.")) events.push(e);
  assert.equal(events.length,1);
  assert.equal(events[0].payload.failure.params.timeoutReason,"cleanup_timeout");
});
