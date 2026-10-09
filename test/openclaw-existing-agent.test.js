import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalOpenClawGateway, createOpenClawAdapter } from "../packages/octo-harness-adapter-openclaw/dist/index.js";
import { assertContextEnvelope, assertResolvedExecutionPlan, mergeContext } from "../packages/octo-harness-protocol/dist/index.js";
import { assertFrozenContextPlan } from "../packages/octo-harness-daemon/dist/run-context.js";
import { loadManagedAgentWorksFromRoot } from "../packages/octo-harness-daemon/dist/index.js";
import { HarnessEngine, MemoryStore } from "../packages/octo-harness-core/dist/index.js";

test("OpenClaw target validation, replacement and frozen-plan consistency", () => {
 const envelope = payload => ({ schema:"octo.context-envelope/v2", items:[{namespace:"octo.execution",name:"config",payload:{adapter:payload}}] });
 const openclaw = envelope({type:"openclaw",provider_agent_id:"main"});
 assertContextEnvelope(openclaw);
 for (const payload of [{type:"openclaw"},{type:"openclaw",provider_agent_id:" "},{type:"codex",provider_agent_id:"main"}]) assert.throws(() => assertContextEnvelope(envelope(payload)));
 assert.deepEqual(mergeContext(openclaw,envelope({type:"codex"})).items[0].payload,{adapter:{type:"codex"}});
 const plan={agent_source: "provisioned", adapter_type:"openclaw",provider_agent_id:"main",workdir:"/workspace",approval_mode:"full_access"};
 assertResolvedExecutionPlan(plan);
 Object.assign(openclaw.items[0].payload,{workspace:{mode:"fixed",path:"/workspace"},approval_policy:{mode:"full_access"}});
 assertFrozenContextPlan(openclaw,plan);
 assert.throws(()=>assertFrozenContextPlan(openclaw,{...plan,provider_agent_id:"other"}),/CONTEXT_PLAN_MISMATCH/);
});

test("local discovery handles a later install, JSON5, token rotation and removed configuration", async t => {
 const home=await mkdtemp(join(tmpdir(),"octo-openclaw-"));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await assert.rejects(loadLocalOpenClawGateway(home),/config_not_found/);
 await mkdir(join(home,".openclaw"));
 const config=join(home,".openclaw","openclaw.json");
 await writeFile(config,"{ // comment\n gateway:{mode:'local',port:19001,auth:{mode:'token',token:'first'}} }");
 const discovered=await Promise.all(Array.from({length:20},()=>loadLocalOpenClawGateway(home)));
 const first=discovered[0];
 assert.ok(discovered.every(value=>value.device.deviceId===first.device.deviceId));
 assert.equal(first.url,"ws://127.0.0.1:19001");
 assert.equal(first.token,"first");
 await writeFile(config,JSON.stringify({gateway:{port:19002,auth:{token:"second"}}}));
 const second=await loadLocalOpenClawGateway(home);
 assert.equal(second.token,"second");
 assert.equal(second.url,"ws://127.0.0.1:19002");
 assert.deepEqual(second.device,first.device);
 await writeFile(config,"invalid");
 await assert.rejects(loadLocalOpenClawGateway(home),/config_invalid/);
 await rm(config);
 await assert.rejects(loadLocalOpenClawGateway(home),/config_not_found/);
});

test("existing instance invocation preserves provider configuration and uses the explicit target", async () => {
 const calls=[];
 const client={
  connect:async()=>({protocol:4,features:{methods:["agents.list","sessions.create","sessions.messages.subscribe","agent","agent.wait","sessions.abort"],events:["agent"]}}),
  onEvent:()=>()=>{}, close:async()=>{},
  request:async(method,params)=>{
   calls.push({method,params});
   if(method==="agents.list")return {agents:[{id:"main"},{id:"researcher"}]};
   if(method==="sessions.create")return {key:params.key};
   if(method==="agent")return {status:"ok",result:{payloads:[{text:"done"}]}};
   if(method==="agent.wait")return {status:"ok"};
   return {};
  }
 };
 const request={protocolVersion:2,invocationId:"i",runId:"r",agentSessionId:"s",workdir:"",prompt:"work",approvalMode:"full_access",agentSource: "preset", agentConfig:{providerAgentId:"researcher",providerOptions:{OPENCLAW_GATEWAY_URL:"ws://127.0.0.1:18789",OPENCLAW_GATEWAY_TOKEN:"fixture",OPENCLAW_GATEWAY_DEVICE_ID:"d",OPENCLAW_GATEWAY_PUBLIC_KEY:"p",OPENCLAW_GATEWAY_PRIVATE_KEY:"k"}}};
 const events=[];
 for await(const event of createOpenClawAdapter({clientFactory:()=>client}).invoke(request))events.push(event);
 assert.equal(events.at(-1).type,"run.completed");
 assert.equal(calls.find(c=>c.method==="agent").params.agentId,"researcher");
 assert.equal(calls.find(c=>c.method==="agent").params.promptMode,undefined);
 assert.equal(calls.find(c=>c.method==="sessions.create").params.cwd,undefined);
 assert.equal(calls.some(c=>["config.get","config.patch","agents.create"].includes(c.method)),false);
});

test("local Harness dispatch freezes the Context target ahead of legacy agent configuration", async () => {
 const requests=[];
 const host={list:()=>[{type:"openclaw"}],async *invoke(_type,request){requests.push(request);yield {protocolVersion:2,type:"run.completed",payload:{}};}};
 const engine=new HarnessEngine({store:new MemoryStore(),host});
 const agent=await engine.registerAgent({name:"existing",agentSource:"provisioned",config:{providerAgentId:"old-runner"},defaultContext:{schema:"octo.context-envelope/v2",items:[ { namespace: "octo.execution", name: "config", payload: { ...{ adapter: {type:"openclaw",provider_agent_id:"main"} }, ...{ workspace: {mode:"fixed",path:"/workspace"} }, ...{ approval_policy: {mode:"full_access"} } } } ]}});
 const submitted=await engine.submitAgentRun({namespace:"local",agentId:agent.id,sessionKey:"v1/task/existing",trigger:{kind:"manual",occurrenceId:"once"},input:{prompt:"work"},context:{schema:"octo.context-envelope/v2",items:[]}});
 await engine.executeRun(submitted.agentRun.id);
 assert.equal(requests[0].agentConfig.providerAgentId,"main");
 assert.equal(submitted.agentRun.resolvedExecutionPlan.provider_agent_id,"main");
});

test("embedded local discovery ignores an unusable historical OpenClaw profile", async t => {
 const home=await mkdtemp(join(tmpdir(),"octo-openclaw-profile-"));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(join(home,"default","identity"),{recursive:true});
 await mkdir(join(home,"default","credentials"));
 await writeFile(join(home,"config.json"),JSON.stringify({schema_version:1,default_profile:"default"}));
 await writeFile(join(home,"default","config.json"),JSON.stringify({schema_version:1,profile:"default",agent_work_url:"https://worker.example",adapters:{openclaw:{execution:{provider_agent_id:"old-runner",provider_options:{},credential_ref:"credentials/deleted.json"}}}}));
 await writeFile(join(home,"default","identity","runtime.json"),JSON.stringify({schema_version:1,profile:"default",runtime_id:"r"}));
 await writeFile(join(home,"default","credentials","runtime-token.json"),JSON.stringify({schema_version:1,access_token:"fixture"}));
 assert.throws(()=>loadManagedAgentWorksFromRoot(home,["default"]));
 const runtimes=loadManagedAgentWorksFromRoot(home,["default"],{discoverLocalOpenClaw:true});
 assert.equal(runtimes.length,1);
 assert.equal(runtimes[0].adapterConfigurations,undefined);
});
