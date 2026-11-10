import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { root } from './bootstrap.mjs';
import { argumentsFrom, invokeMcp } from './mcp.mjs';

function fixture(t) {
  const base = join(root, 'work');
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(join(base, 'mcp-test-'));
  const path = join(folder, 'arguments.json');
  t.after(() => { rmSync(path, { force: true }); rmdirSync(folder); });
  return path;
}

function processFixture(emit) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', 1); };
  const received = [];
  child.stdin.on('data', (chunk) => received.push(chunk));
  let invocation;
  const spawnProcess = (...args) => {
    invocation = args;
    queueMicrotask(() => emit(child));
    return child;
  };
  return { child, spawnProcess, input: () => Buffer.concat(received), invocation: () => invocation };
}

test('arguments are bounded UTF-8 JSON objects, never interpolated into commands', (t) => {
  const path = fixture(t);
  const args = { work_id: 'synthetic-work', objective: 'Quotes " and $() stay data' };
  writeFileSync(path, JSON.stringify(args));
  assert.deepEqual(JSON.parse(argumentsFrom(['sabre_get_work', path])), { tool: 'sabre_get_work', arguments: args });
  assert.deepEqual(JSON.parse(argumentsFrom([])), { tool: 'tools', arguments: {} });
  for (const input of ['[]', 'null', '{"secret":"synthetic-private-value"', JSON.stringify({ data: 'x'.repeat(65536) }), Buffer.from([0xff])]) {
    writeFileSync(path, input);
    assert.throws(() => argumentsFrom(['sabre_get_work', path]), (error) => error.code === 'MCP_INPUT_INVALID' && !error.message.includes('synthetic-private-value'));
  }
  for (const argv of [['exec'], ['tools', path], ['sabre_get_work', path, 'extra']]) {
    assert.throws(() => argumentsFrom(argv), { code: 'MCP_INPUT_INVALID' });
  }
});

test('the subprocess receives stdin data with a sanitized environment and stderr stays private', async (t) => {
  const previous = process.env.SABRE_AUTH_TOKEN;
  process.env.SABRE_AUTH_TOKEN = 'synthetic-private-bootstrap-token';
  t.after(() => { if (previous === undefined) delete process.env.SABRE_AUTH_TOKEN; else process.env.SABRE_AUTH_TOKEN = previous; });
  const fixture = processFixture((child) => {
    child.stderr.end('synthetic-private-bootstrap-token');
    child.stdout.end(JSON.stringify({ ok: true, value: { result: [] } }));
    child.emit('close', 0);
  });
  const payload = argumentsFrom(['sabre_list_work']);
  assert.deepEqual(await invokeMcp(payload, { spawnProcess: fixture.spawnProcess }), { result: [] });
  assert.equal(fixture.input().toString(), payload.toString());
  const [, args, options] = fixture.invocation();
  assert.equal(options.env.SABRE_AUTH_TOKEN, undefined);
  assert.equal(options.windowsHide, true);
  assert.equal(args.some((value) => value.includes('synthetic-private-bootstrap-token') || value === 'sabre_list_work'), false);
  assert.deepEqual(args.slice(-7, -1), ['exec', '-i', 'sabre-factory-api-1', 'python', '-I', '-c']);
});

test('oversized output and elapsed deadline stop the client without automatic retry', async () => {
  const overflow = processFixture((child) => child.stdout.write(Buffer.alloc(1024 * 1024 + 1)));
  await assert.rejects(invokeMcp(argumentsFrom(['tools']), { spawnProcess: overflow.spawnProcess }), { code: 'MCP_OUTPUT_LIMIT' });
  assert.equal(overflow.child.killed, true);
  const timeout = processFixture(() => {});
  await assert.rejects(invokeMcp(argumentsFrom(['tools']), { spawnProcess: timeout.spawnProcess, timeoutMs: 10 }), { code: 'MCP_TIMEOUT' });
  assert.equal(timeout.child.killed, true);
});

test('transport errors and malformed responses expose only fixed diagnostics', async () => {
  for (const [output, code] of [['synthetic-secret-invalid-json', 0], [JSON.stringify({ ok: false, code: 'synthetic-secret-code' }), 0], ['synthetic-secret-output', 2]]) {
    const fixture = processFixture((child) => { child.stdout.end(output); child.emit('close', code); });
    await assert.rejects(invokeMcp(argumentsFrom(['tools']), { spawnProcess: fixture.spawnProcess }),
      (error) => error.code === 'MCP_UNAVAILABLE' && !error.message.includes('synthetic-secret'));
  }
});
