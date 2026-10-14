import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalOpenClawGateway, configureOpenClawConnection, createOpenClawAdapter } from "../packages/octo-runtime-adapter-openclaw/dist/index.js";
import { assertContextEnvelope, assertResolvedExecutionPlan, mergeContext } from "../packages/octo-runtime-protocol/dist/index.js";
import { assertFrozenContextPlan } from "../packages/octo-runtime-protocol/dist/index.js";
import { loadManagedAgentWorksFromRoot } from "../packages/octo-runtime-worker-access/dist/index.js";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";

test("OpenClaw target validation, replacement and frozen-plan consistency", () => {
 const envelope = payload => ({ schema:"octo.context-envelope/v3", items:[{ namespace: "octo.execution", name: "adapter", payload: payload }] });
 const openclaw = envelope({type:"openclaw",provider_agent_id:"main"});
 assertContextEnvelope(openclaw);
 for (const payload of [{type:"openclaw"},{type:"openclaw",provider_agent_id:" "},{type:"codex",provider_agent_id:"main"}]) assert.throws(() => assertContextEnvelope(envelope(payload)));
 assert.deepEqual(mergeContext(openclaw,envelope({type:"codex"})).items[0].payload,{type:"codex"});
 const plan={agent_source: "provisioned", adapter_type:"openclaw",provider_agent_id:"main",workdir:"/workspace",approval_mode:"full_access"};
 assertResolvedExecutionPlan(plan);
 openclaw.items.push({namespace:"octo.execution",name:"workspace",payload:{mode:"fixed",path:"/workspace"}}, {namespace:"octo.security",name:"approval_policy",payload:{mode:"full_access"}});
 assertFrozenContextPlan(openclaw,plan);
 assert.throws(()=>assertFrozenContextPlan(openclaw,{...plan,provider_agent_id:"other"}),/CONTEXT_PLAN_MISMATCH/);
});

test("local discovery handles a later install, JSON5, token rotation and removed configuration", async t => {
 const home=await mkdtemp(join(tmpdir(),"octo-openclaw-"));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await configureOpenClawConnection(home, {openclawHome:join(home,".openclaw")});
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

test("local discovery rejects malformed device identities", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "octo-openclaw-identity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".openclaw"));
  await writeFile(
    join(home, ".openclaw", "openclaw.json"),
    JSON.stringify({ gateway: { auth: { token: "fixture" } } })
  );
  await configureOpenClawConnection(home, {openclawHome:join(home,".openclaw")});
  const root = join(home, "credentials");
  await mkdir(root, { recursive: true });
  for (const device of [
    null,
    [],
    { deviceId: "device", publicKey: "public" },
    { deviceId: 42, publicKey: "public", privateKey: "private" },
    { deviceId: "device", publicKey: "public", privateKey: "" }
  ]) {
    await writeFile(join(root, "openclaw-device.json"), JSON.stringify(device));
    await assert.rejects(loadLocalOpenClawGateway(home), /device_identity_invalid/);
  }
});

for (const { agentSource, target, workdir } of [
 { agentSource: "preset", target: "researcher", workdir: "" },
 { agentSource: "preset", target: "researcher", workdir: "/missing/non-git-directory" },
 { agentSource: "provisioned", target: "main", workdir: "/missing/non-git-directory" },
 { agentSource: "provisioned", target: "main", workdir: "" }
]) test(`existing ${target} invocation from ${agentSource} ignores workdir ${JSON.stringify(workdir)}`, async () => {
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
 const request={context:{schema:"octo.context-envelope/v3",items:[
  {namespace:"octo.execution",name:"adapter",payload:{type:"openclaw",provider_agent_id:target}},
  {namespace:"octo.execution",name:"workspace",payload:workdir ? {mode:"fixed",path:workdir} : {mode:"random"}}
 ]},protocolVersion:2,invocationId:"i",runId:"r",agentSessionId:"s",workdir,prompt:"work",modelInput:"work",controlInstructions:"",approvalMode:"full_access",agentSource, agentConfig:{providerAgentId:target,providerOptions:{OPENCLAW_GATEWAY_URL:"ws://127.0.0.1:18789",OPENCLAW_GATEWAY_TOKEN:"fixture",OPENCLAW_GATEWAY_DEVICE_ID:"d",OPENCLAW_GATEWAY_PUBLIC_KEY:"p",OPENCLAW_GATEWAY_PRIVATE_KEY:"k"}}};
 const host=new AdapterHost();
 host.register(createOpenClawAdapter({clientFactory:()=>client}));
 assert.equal(host.list()[0].workspace,false);
 const events=[];
 for await(const event of host.invoke("openclaw",request,{protocolMode:"canonical"}))events.push(event);
 assert.equal(events.at(-1).type,"run.completed");
 assert.equal(calls.find(c=>c.method==="agent").params.agentId,target);
 assert.equal(calls.find(c=>c.method==="agent").params.promptMode,undefined);
 assert.equal(calls.find(c=>c.method==="sessions.create").params.cwd,undefined);
 for(const {params} of calls) for(const key of ["cwd","workdir","workspace"]) assert.equal(params[key],undefined);
 assert.equal(calls.some(c=>["config.get","config.patch","agents.create"].includes(c.method)),false);
});


test("managed Runtime rejects obsolete external bindings without ignoring local configuration", async t => {
 const home=await mkdtemp(join(tmpdir(),"octo-openclaw-profile-"));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await mkdir(join(home,"default","identity"),{recursive:true});
 await mkdir(join(home,"default","credentials"));
 await writeFile(join(home,"config.json"),JSON.stringify({schema_version:1,default_profile:"default"}));
 await writeFile(join(home,"default","config.json"),JSON.stringify({schema_version:1,profile:"default",agent_work_url:"https://worker.example",adapters:{openclaw:{execution:{provider_agent_id:"old-runner",provider_options:{},credential_ref:"credentials/deleted.json"}}}}));
 await writeFile(join(home,"default","identity","runtime.json"),JSON.stringify({schema_version:1,profile:"default",runtime_id:"r"}));
 await writeFile(join(home,"default","credentials","runtime-token.json"),JSON.stringify({schema_version:1,access_token:"fixture"}));
 assert.throws(()=>loadManagedAgentWorksFromRoot(home,["default"]));
 await writeFile(join(home,"default","config.json"),JSON.stringify({schema_version:1,profile:"default",agent_work_url:"https://worker.example"}));
 const runtimes=loadManagedAgentWorksFromRoot(home,["default"]);
 assert.equal(runtimes.length,1);
 assert.deepEqual(runtimes[0].adapterConfigurations.openclaw,{providerOptions:{OPENCLAW_RUNTIME_ROOT:join(home,"default")}});
});
