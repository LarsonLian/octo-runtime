import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeDaemonRun } from '../packages/octo-harness-embedded/dist/run-stream.js';
import { invokeRequest } from './agent-work-runtime-fixture.js';

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'octo-invoke-')), path = join(root, 'host.sock');
  const connections = new Set();
  const server = createServer(socket => {
    connections.add(socket); socket.once('close', () => connections.delete(socket));
    socket.setEncoding('utf8'); let pending = '';
    socket.on('data', chunk => { pending += chunk; if (pending.includes('\n')) handler(JSON.parse(pending.slice(0, pending.indexOf('\n'))), socket); });
  });
  await new Promise(resolve => server.listen(path, resolve));
  t.after(async () => { for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return path;
}
const event = (request, stream, seq, canonical) => ({ jsonrpc: '2.0', method: 'agent_run.event', params: { run_id: request.runId, stream_id: stream, seq, event: canonical } });
const write = (socket, frame) => socket.write(JSON.stringify(frame) + '\n');

test('local invoke repairs IPC disconnect without submitting again or losing full canonical payloads', async t => {
  const request = invokeRequest(), calls = [], stream = 'host:epoch';
  const canonical = [
    { protocolVersion: 2, type: 'run.started', payload: {} },
    { protocolVersion: 2, type: 'message.delta', payload: { channel: 'analysis', exposure: 'private_reasoning', text: 'provider detail', metadata: { a: [1, 2] } } },
    { protocolVersion: 2, type: 'run.completed', payload: {} },
  ];
  const path = await fixture(t, (rpc, socket) => {
    calls.push(rpc); assert.equal(rpc.jsonrpc, '2.0');
    write(socket, { jsonrpc: '2.0', id: rpc.id, result: { run_id: request.runId, stream_id: stream } });
    if (rpc.method === 'agent_run.invoke') { write(socket, event(request, stream, 1, canonical[0])); socket.end(); }
    else { write(socket, event(request, stream, 2, canonical[1])); write(socket, event(request, stream, 3, canonical[2])); socket.end(); }
  });
  const received = []; for await (const value of invokeDaemonRun(path, 'codex', request)) received.push(value);
  assert.deepEqual(received, canonical);
  assert.deepEqual(calls.map(rpc => rpc.method), ['agent_run.invoke', 'agent_run.subscribe']);
  assert.equal(calls[1].params.after_seq, 1); assert.equal(calls[1].params.stream_id, stream);
});

test('source expiration fails explicitly and never reinvokes the adapter', async t => {
  const request = invokeRequest(), calls = [];
  const path = await fixture(t, (rpc, socket) => {
    calls.push(rpc.method);
    if (rpc.method === 'agent_run.invoke') write(socket, { jsonrpc: '2.0', id: rpc.id, result: { run_id: request.runId, stream_id: 'original' } });
    else write(socket, { jsonrpc: '2.0', id: rpc.id, error: { message: 'STREAM_EXPIRED' } });
    socket.end();
  });
  await assert.rejects(async () => { for await (const value of invokeDaemonRun(path, 'codex', request)) void value; }, /STREAM_EXPIRED/);
  assert.deepEqual(calls, ['agent_run.invoke', 'agent_run.subscribe']);
});
