import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createCipheriv, createDecipheriv, createPublicKey, generateKeyPairSync, diffieHellman } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ImRuntime, loadImBots } from '../packages/octo-harness-im/dist/index.js';
import { waitFor } from './agent-work-runtime-fixture.js';
const md5 = s => createHash('md5').update(s).digest('hex');
const str = s => { const b=Buffer.from(s),h=Buffer.alloc(2);h.writeUInt16BE(b.length);return Buffer.concat([h,b]); };
const u32 = n => {const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const u64 = n => {const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;};
const pack=(header,body)=>{let n=body.length;const bytes=[];do{let b=n%128;n=Math.floor(n/128);if(n)b|=128;bytes.push(b);}while(n);return Buffer.concat([Buffer.from([header,...bytes]),body]);};
const unpack=b=>{let i=1;while(b[i++]&128){};return b.subarray(i);};
function reader(b){let p=0;return {byte:()=>b[p++],str:()=>{const n=b.readUInt16BE(p);p+=2;const s=b.subarray(p,p+n).toString();p+=n;return s;},u32:()=>{const n=b.readUInt32BE(p);p+=4;return n;},rest:()=>b.subarray(p)};}

test('IM owns one binary WS, reuses session, resets provider handle, and replies only after Host terminal', async t=>{
 const dir=await mkdtemp(join(tmpdir(),'oh-im-'));let conn,key;const iv=Buffer.from('0123456789abcdef');const replies=[],calls=[];
 const crypt=(text,decrypt=false)=>{const cipher=decrypt?createDecipheriv('aes-128-cbc',key,iv):createCipheriv('aes-128-cbc',key,iv);return Buffer.concat([cipher.update(decrypt?Buffer.from(text,'base64'):Buffer.from(text)),cipher.final()]).toString(decrypt?'utf8':'base64');};
 const server=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer bf_fixture');
  const chunks=[];for await(const c of req)chunks.push(c);
  if(req.url==='/v1/bot/register'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({robot_id:'bot',owner_uid:'owner',owner_channel_id:'owner',im_token:'secret',ws_url:`ws://127.0.0.1:${server.address().port}`}));}
  else res.end('{}');
 });
 const ws=new WebSocketServer({server});
 ws.on('connection',socket=>{conn=socket;socket.on('message',data=>{
  const header=data[0],kind=header>>4,r=reader(unpack(data));
  if(kind===1){assert.equal(r.byte(),4);r.byte();r.str();assert.equal(r.str(),'bot');assert.equal(r.str(),'secret');const remaining=r.rest();const cr=reader(remaining.subarray(8));const publicBytes=Buffer.from(cr.str(),'base64');const pair=generateKeyPairSync('x25519');const pub=createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b656e032100','hex'),publicBytes])});key=Buffer.from(md5(diffieHellman({privateKey:pair.privateKey,publicKey:pub}).toString('base64')).slice(0,16));socket.send(pack(0x21,Buffer.concat([Buffer.from([4]),u64(0),Buffer.from([1]),str(pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('base64')),str(iv.toString()),u64(1)])));}
  if(kind===3){assert.equal(header&2,2,'normal messages must update conversation unread state');r.byte();const seq=r.u32(),clientNo=r.str(),channel=r.str(),type=r.byte();r.u32();const hash=r.str(),payload=r.rest().toString();assert.equal(hash,md5(crypt(`${seq}${clientNo}${channel}${type}${payload}`)));const value=JSON.parse(crypt(payload,true));assert.equal(value.space_id,'space');replies.push(value.content);socket.send(pack(0x40,Buffer.concat([u64(100+seq),u32(seq),u32(seq),Buffer.from([1])])));}
 });});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const tokenFile=join(dir,'token');await writeFile(tokenFile,'bf_fixture',{mode:0o600});
 const host={list:async()=>[],probe:async()=>({}),cancel:async()=>({cancelled:true}),respondInteraction:async()=>{},async *invoke(adapter,request){assert.equal(adapter,'codex');assert.equal(request.approvalMode,'full_access');assert.equal(request.runMetadata.actorId,'owner');calls.push(request);yield {protocolVersion:2,type:'session.update',payload:{providerSession:{sessionId:'provider-session'}}};yield {protocolVersion:2,type:'message.delta',payload:{messageId:'answer',channel:'final',text:'完整'}};yield {protocolVersion:2,type:'message.update',payload:{messageId:'answer',channel:'final',text:'完整答复'}};assert.equal(replies.length,calls.length===1?0:3);yield {protocolVersion:2,type:'run.completed',payload:{}};}};
 const runtime=new ImRuntime({id:'fixture',apiUrl:`http://127.0.0.1:${server.address().port}`,botId:'bot',spaceId:'space',tokenFile,adapterType:'codex',workdir:dir,context:{schema:'octo.context-envelope/v3',items:[]}},{host});
 t.after(async()=>{await runtime.close();ws.close();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 await runtime.start();assert.equal(runtime.status.connected,true);
 let seq=0;
 const send=content=>{const n=++seq,id=BigInt(1000+n),stamp=12345,clientNo=`incoming-${n}`,payload=crypt(JSON.stringify({type:1,content,space_id:'space'}));const hash=md5(crypt(`${id}${n}${clientNo}${stamp}ownerbot1${payload}`));conn.send(pack(0x52,Buffer.concat([Buffer.from([0]),str(hash),str('owner'),str('bot'),Buffer.from([1]),u32(0),str(clientNo),u64(id),u32(n),u32(stamp),Buffer.from(payload)])));};
 send('hello');await waitFor(()=>replies.length===1);assert.equal(replies[0],'完整答复');const session=runtime.status.sessions[0].sessionId;
 send('/session');await waitFor(()=>replies.length===2);assert.match(replies[1],new RegExp(session));
 send('/reset');await waitFor(()=>replies.length===3);assert.match(replies[2],/generation=2/);
 send('after reset');await waitFor(()=>replies.length===4);assert.equal(calls.length,2);assert.equal(calls[1].providerSession,undefined);assert.equal(calls[1].agentSessionId,session);assert.equal(calls[1].sessionGeneration,2);
});

test('duplicate bot identities fail before opening connections',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'oh-im-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bot={id:'a',apiUrl:'https://im.example/api',botId:'bot',spaceId:'s',tokenFile:'token',adapterType:'codex',workdir:dir,context:{schema:'octo.context-envelope/v3',items:[]}};
 await writeFile(join(dir,'im.json'),JSON.stringify({bots:[bot,{...bot,id:'b'}]}));assert.throws(()=>loadImBots(dir),/IM_BOT_DUPLICATED/);
});
