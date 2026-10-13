import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAnthropicMaterialCompactionPort,createClaudeMaterialCompactionPort} from '../packages/octo-harness-context-builder/dist/anthropic-material-compaction.js';
import {compactContextMaterials} from '../packages/octo-harness-context-builder/dist/context-compaction.js';
const base={model:'qwen3.8-flash',baseUrl:'https://provider.example',apiKey:'private-fixture',auth:'bearer',contextWindow:1000000,maxInputTokens:991808,capacitySource:'official',protectedInput:'current request',instructions:'trusted instructions'};

test('Anthropic-compatible missing count endpoint uses actual one-token no-tool usage and cache totals',async()=>{
 const calls=[];
 const port=createAnthropicMaterialCompactionPort({...base,fetch:async(url,options)=>{const body=JSON.parse(options.body);calls.push({url:String(url),body});return String(url).endsWith('count_tokens')?Response.json({error:{type:'invalid_request_error'}},{status:404}):Response.json({usage:{input_tokens:20,cache_read_input_tokens:10,cache_creation_input_tokens:5},content:[{type:'text',text:'x'}],stop_reason:'max_tokens'})}});
 assert.equal(await port.measureInputTokens('facts',AbortSignal.timeout(1000)),35);
 assert.equal(port.inputTokenCountKind,'exact');assert.equal(calls.length,2);
 assert.equal(calls[1].body.max_tokens,1);assert.deepEqual(calls[1].body.tools,[]);assert.deepEqual(calls[1].body.tool_choice,{type:'none'});assert.deepEqual(calls[1].body.thinking,{type:'disabled'});
 assert.equal(calls[1].body.system,'trusted instructions');assert.match(calls[1].body.messages[0].content,/current request.*facts/s);
 await port.countTokens('another',AbortSignal.timeout(1000));assert.equal(calls.length,3);
});

test('Provider capacity rejection is an explicit lower bound, never fabricated exact tokens',async()=>{
 const fetch=async(url)=>String(url).endsWith('count_tokens')?Response.json({},{status:404}):Response.json({error:{message:'Range of input length should be [1, 991808]'}},{status:400});
 const port=createAnthropicMaterialCompactionPort({...base,fetch});
 assert.equal(await port.measureInputTokens('large',AbortSignal.timeout(1000)),991809);
 assert.equal(port.inputTokenCountKind,'lower_bound');
 const mismatch=createAnthropicMaterialCompactionPort({...base,fetch:async(url)=>String(url).endsWith('count_tokens')?Response.json({},{status:404}):Response.json({error:{message:'Range of input length should be [1, 8192]'}},{status:400})});
 await assert.rejects(mismatch.measureInputTokens('large',AbortSignal.timeout(1000)),/CAPACITY_MISMATCH/);
});

test('native count endpoint and summaries keep separate protocol contracts',async()=>{
 const bodies=[];
 const port=createAnthropicMaterialCompactionPort({...base,fetch:async(url,options)=>{const body=JSON.parse(options.body);bodies.push(body);return String(url).endsWith('count_tokens')?Response.json({input_tokens:100}):Response.json({stop_reason:'end_turn',content:[{type:'text',text:'retained facts'}]})}});
 assert.equal(await port.countTokens('facts',AbortSignal.timeout(1000)),100);assert.equal(bodies[0].max_tokens,undefined);
 assert.equal(await port.summarize('facts',50,AbortSignal.timeout(1000)),'retained facts');assert.equal(bodies[1].max_tokens,50);assert.deepEqual(bodies[1].tools,[]);
});

test('compaction receipt preserves the initial lower-bound qualifier after later exact measurements',async()=>{
 let kind='exact';let saved;
 const port={model:'fixture',contextWindow:1024,outputReserveTokens:64,summaryInputLimit:512,toolsDisabled:true,
  get inputTokenCountKind(){return kind},measureInputTokens:async(text)=>{kind=text==='original'?'lower_bound':'exact';return text==='original'?1025:100},countTokens:async(text)=>text==='original'?200:10,summarize:async()=> 'facts'};
 const result=await compactContextMaterials({runId:'lower-bound',material:'original',protectedIdentity:'protected',sourceRefs:[],signal:AbortSignal.timeout(1000),port,store:{load:async()=>undefined,save:async(_id,value)=>{saved=value;return value}}});
 assert.equal(result.receipt.inputTokenCountKind,'lower_bound');assert.equal(saved.inputTokens,1025);
});

test('effective CLI window remains below upstream capacity with its own output reserve', () => {
 const port=createAnthropicMaterialCompactionPort({...base,contextWindow:200000,outputReserveTokens:32000});
 assert.equal(port.contextWindow,200000);assert.equal(port.outputReserveTokens,32000);
 assert.equal(port.summaryInputLimit,131072);
 assert.throws(()=>createAnthropicMaterialCompactionPort({...base,outputReserveTokens:1000000}),/CAPACITY_UNAVAILABLE/);
});

test('Claude factory pins the configured concrete model and conservative CLI capacity', async () => {
 const root=await mkdtemp(join(tmpdir(),'claude-capacity-'));
 try {
  await writeFile(join(root,'settings.json'),JSON.stringify({model:'unqualified',env:{ANTHROPIC_MODEL:'qwen3.8-flash',ANTHROPIC_AUTH_TOKEN:'fixture',ANTHROPIC_BASE_URL:'https://provider.example'}}));
  const args={configDir:root,env:{ANTHROPIC_MODEL:'inherited-alias'},protectedInput:'request',instructions:'',signal:AbortSignal.timeout(1000)};
  const port=await createClaudeMaterialCompactionPort(args);
  assert.equal(port.model,'qwen3.8-flash');assert.equal(port.contextWindow,200000);assert.equal(port.outputReserveTokens,32000);
  await assert.rejects(createClaudeMaterialCompactionPort({...args,model:'unknown'}),/CAPACITY_UNAVAILABLE/);
 } finally {await rm(root,{recursive:true,force:true});}
});
