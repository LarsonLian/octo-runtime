import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRunService } from '../packages/octo-harness-daemon/dist/host-run-service.js';
import { invokeRequest, waitFor } from './agent-work-runtime-fixture.js';
function fixture(invoke){return new HostRunService({invoke,list:async()=>[],probe:async()=>({}),cancel:async()=>({cancelled:true}),respondInteraction:async()=>{}});}
test('local submit is retained before first subscribe, never requires Worker, and rejects duplicate execution',async()=>{
 let count=0;const host=fixture(async function*(){count++;yield{protocolVersion:2,type:'message.delta',payload:{text:'private',channel:'analysis',exposure:'private_reasoning'}};yield{protocolVersion:2,type:'message.delta',payload:{text:'answer',channel:'final'}};yield{protocolVersion:2,type:'run.completed',payload:{}};});
 const input=invokeRequest(),accepted=host.submit('codex',input);await waitFor(()=>host.get(input.runId).terminal);
 const page=host.read(input.runId,accepted.stream_id,0);assert.deepEqual(page.events.map(e=>e.seq),[1,2,3]);assert.equal(page.events[0].event.payload.text,'private');assert.equal(page.events[1].event.payload.text,'answer');
 assert.throws(()=>host.submit('codex',input),/RUN_ALREADY_ACCEPTED/);assert.equal(count,1);assert.equal(host.read(input.runId,accepted.stream_id,1).events[0].seq,2);
 assert.throws(()=>host.read(input.runId,'stale',0),/STREAM_EXPIRED/);assert.throws(()=>host.read(input.runId,accepted.stream_id,4),/STREAM_CURSOR_INVALID/);await host.close();
});
test('byte pressure creates an explicit gap while terminal state remains independently queryable',async()=>{
 const host=fixture(async function*(){for(let i=0;i<100;i++)yield{protocolVersion:2,type:'message.delta',payload:{text:'x'.repeat(65536),channel:'final'}};yield{protocolVersion:2,type:'run.completed',payload:{}};});
 const input=invokeRequest();host.submit('codex',input);await waitFor(()=>host.get(input.runId).terminal);
 assert.throws(()=>host.read(input.runId,undefined,0),error=>error.message==='STREAM_GAP'&&error.data.oldest_seq>1);
 const info=host.get(input.runId);assert.equal(info.terminal.type,'run.completed');assert.ok(host.read(input.runId,undefined,info.oldest_seq-1).events.length<=32);
 const leases=Array.from({length:16},()=>host.acquireSubscription());assert.throws(()=>host.acquireSubscription(),/STREAM_SUBSCRIBER_LIMIT/);leases.forEach(release=>{release();release();});host.acquireSubscription()();await host.close();
});
