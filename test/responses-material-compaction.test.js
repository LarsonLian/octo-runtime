import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResponsesMaterialCompactionPort, createCodexMaterialCompactionPort } from "../packages/octo-harness-daemon/dist/responses-material-compaction.js";
import { buildCodexCommand } from "../packages/octo-harness-adapter-codex/dist/index.js";

const base = {model:"known",baseUrl:"https://provider.example/v1",apiKey:"private-test-key",contextWindow:8192,capacitySource:"trusted-test",protectedInput:"retain current input",instructions:"trusted control"};
test("Responses precisely counts explicit input and disables tools in summary wire request",async()=>{
 const calls=[];
 const port=createResponsesMaterialCompactionPort({...base,fetch:async(url,options)=>{
  const body=JSON.parse(options.body);calls.push({url:String(url),body,signal:options.signal});
  return Response.json(String(url).endsWith("input_tokens")?{input_tokens:421}:{status:"completed",output:[{type:"message",content:[{type:"output_text",text:"concrete retained evidence"}]}]});
 }});
 const signal=AbortSignal.timeout(1000);
 assert.equal(await port.measureInputTokens("untrusted facts",signal),421);
 assert.equal(await port.measureInputTokens("untrusted facts",signal),421);
 assert.equal(calls.length,1);
 assert.match(calls[0].body.input[0].content[0].text,/retain current input.*untrusted facts/s);
 assert.equal(calls[0].body.instructions,"trusted control");
 assert.equal(await port.summarize("source",100,signal),"concrete retained evidence");
 const body=calls[1].body;
 assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,"none");assert.equal(body.store,false);assert.equal(body.truncation,"disabled");
 assert.equal(body.max_output_tokens,100);assert.equal(calls[1].signal,signal);
 assert.equal(port.measurementMode,"provider_native");
});

test("Responses incomplete summaries, tool outputs and Provider errors fail explicitly",async()=>{
 for(const response of [{status:"incomplete",output:[]},{status:"completed",output:[{type:"function_call",name:"unsafe"}]}]){
  const port=createResponsesMaterialCompactionPort({...base,fetch:async()=>Response.json(response)});
  await assert.rejects(port.summarize("source",100,AbortSignal.timeout(1000)),/CONTEXT_SUMMARY_/);
 }
 const port=createResponsesMaterialCompactionPort({...base,fetch:async()=>new Response("sensitive provider body",{status:401})});
 await assert.rejects(port.countTokens("source",AbortSignal.timeout(1000)),error=>error.message==="CONTEXT_PROVIDER_HTTP_401");
});

test("host capacity is mandatory for an unknown model and env_key owns credentials",async t=>{
 const root=await mkdtemp(join(tmpdir(),"octo-provider-capacity-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,"config.toml"),'model="custom"\nmodel_provider="private"\n[model_providers.private]\nwire_api="responses"\nenv_key="TEST_PROVIDER_KEY"\nbase_url="https://provider.example/v1"\n');
 await assert.rejects(createCodexMaterialCompactionPort({codexHome:root,env:{TEST_PROVIDER_KEY:"secret"},protectedInput:"x",instructions:"",signal:AbortSignal.timeout(1000)}),/CONTEXT_CAPACITY_UNAVAILABLE/);
 await writeFile(join(root,"config.toml"),'model="custom"\nmodel_context_window=8192\nmodel_provider="private"\n[model_providers.private]\nwire_api="responses"\nenv_key="TEST_PROVIDER_KEY"\nbase_url="https://provider.example/v1"\n');
 const port=await createCodexMaterialCompactionPort({codexHome:root,env:{TEST_PROVIDER_KEY:"secret"},protectedInput:"x",instructions:"",signal:AbortSignal.timeout(1000)});
 assert.equal(port.contextWindow,8192);assert.equal(port.capacitySource,"codex.config.model_context_window");
 await assert.rejects(createCodexMaterialCompactionPort({codexHome:root,env:{OPENAI_API_KEY:"wrong-provider"},protectedInput:"x",instructions:"",signal:AbortSignal.timeout(1000)}),/API_KEY_UNAVAILABLE/);
});

test("Codex receives trusted capacity and native history compaction threshold",()=>{
 const command=buildCodexCommand({workdir:"/tmp",runMetadata:{contextCapacity:{contextWindow:8192,outputReserveTokens:2048,management:"provider_native"}}},"codex",["app-server"],{});
 assert.ok(command.args.includes("model_context_window=8192"));assert.ok(command.args.includes("model_auto_compact_token_limit=6144"));
 assert.throws(()=>buildCodexCommand({workdir:"/tmp",runMetadata:{contextCapacity:{contextWindow:0}}}),/CONTEXT_CAPACITY_UNAVAILABLE/);
});

test("native contextCompaction completion persists resumable history evidence",async()=>{
 const {normalizeCodexEvent}=await import("../packages/octo-harness-adapter-codex/dist/index.js");
 const events=normalizeCodexEvent({method:"item/completed",params:{threadId:"history-thread",turnId:"turn-2",item:{id:"native-compact",type:"contextCompaction"}}});
 assert.ok(events.some(e=>e.type==="run.notice"&&e.payload.code==="context_compacted"));
 assert.equal(events.find(e=>e.type==="session.update").payload.providerSession.resumeOutcome,"compacted");
 assert.equal(events.find(e=>e.type==="session.update").payload.providerSession.sessionId,"history-thread");
 assert.equal(events.some(e=>e.type==="run.completed"),false);
});

test("Codex capacity cache matches only the selected model and requires an API key",async t=>{
 const root=await mkdtemp(join(tmpdir(),"octo-codex-model-cache-"));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,"config.toml"),'model="selected-model"\n');
 await writeFile(join(root,"models_cache.json"),JSON.stringify({models:[{slug:"other-model",context_window:999999},{slug:"selected-model",context_window:272000,max_context_window:1000000}]}));
 const options={codexHome:root,env:{OPENAI_API_KEY:"private-fixture"},protectedInput:"input",instructions:"",signal:AbortSignal.timeout(1000)};
 const port=await createCodexMaterialCompactionPort(options);assert.equal(port.contextWindow,272000);assert.equal(port.capacitySource,"codex.models_cache.context_window");
 await assert.rejects(createCodexMaterialCompactionPort({...options,model:"missing-model"}),/CAPACITY_UNAVAILABLE/);
 await writeFile(join(root,"auth.json"),JSON.stringify({tokens:{access_token:"oauth-token-is-not-an-api-key"}}));
 await assert.rejects(createCodexMaterialCompactionPort({...options,env:{}}),/API_KEY_UNAVAILABLE/);
});
