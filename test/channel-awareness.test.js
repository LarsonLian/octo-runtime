import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { channelAwarenessInstructions } from '../packages/octo-harness-daemon/dist/channel-awareness.js';
import { compileRunContext } from '../packages/octo-harness-daemon/dist/run-context.js';
const doc = (kind, content, sub) => ({kind,content,group_id:'g1',...(sub?{subchannel_id:sub}:{}),version:1,digest:`sha256:${createHash('sha256').update(content).digest('hex')}`});
const snapshot = () => ({space_id:'s1',endpoint_id:'ep1',conversation_id:'topic:g1:t1',documents:[doc('group','parent rules'),doc('subchannel','child rules','t1')]});
test('group and subchannel rules enter initial controls in order, not message history',()=>{
 const instructions=channelAwarenessInstructions(snapshot());
 const compiled=compileRunContext({schema:'octo.context-envelope/v3',items:[]},[],instructions);
 assert.equal(compiled.modelContent,'');
 assert.ok(compiled.controlInstructions.indexOf('parent rules')<compiled.controlInstructions.indexOf('child rules'));
 assert.match(compiled.controlInstructions,/subchannel refines/);
});
test('empty subchannel retains parent; empty group explicitly replaces old rules',()=>{
 const value=snapshot();value.documents[1]=doc('subchannel','','t1');
 const text=channelAwarenessInstructions(value)[0].text;
 assert.match(text,/parent rules/);assert.match(text,/replaces all previous/);
 value.conversation_id='group:g1';value.documents=[doc('group','')];
 assert.equal(channelAwarenessInstructions(value).length,1);
 assert.deepEqual(channelAwarenessInstructions(undefined),[]);
});
test('invalid scope, missing parent and tampered content are rejected',()=>{
 const value=snapshot();value.documents[1].content='tampered';
 assert.throws(()=>channelAwarenessInstructions(value),/CHANNEL_AWARENESS_INVALID/);
 const missing=snapshot();missing.documents.shift();assert.throws(()=>channelAwarenessInstructions(missing));
 const dm=snapshot();dm.conversation_id='dm:user';assert.throws(()=>channelAwarenessInstructions(dm));
});
