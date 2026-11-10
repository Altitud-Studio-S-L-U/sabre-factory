import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { openPanelAccess, requireClaudeOwnerTerminal, runClaudeOwnerLogin } from './ops.mjs';

test('Claude account login requires owner stdin and stdout terminals', () => {
  for (const [input, output] of [[{}, {}], [{ isTTY: true }, {}], [{}, { isTTY: true }]]) {
    assert.throws(() => requireClaudeOwnerTerminal(input, output), (error) => error.code === 'CLAUDE_OWNER_TERMINAL_REQUIRED');
  }
  assert.doesNotThrow(() => requireClaudeOwnerTerminal({ isTTY: true }, { isTTY: true }));
});

test('Claude login creates first, then attaches to owner input and cleans its stopped container', async () => {
  const calls = [];
  const owner = { isTTY: true };
  await runClaudeOwnerLogin({ input: owner, output: owner,
    create: async () => { calls.push('create'); }, attach: async () => { calls.push('attach'); }, remove: async () => { calls.push('remove'); } });
  assert.deepEqual(calls, ['create', 'attach', 'remove']);
  const output = { isTTY: true };
  await assert.rejects(runClaudeOwnerLogin({ input: owner, output,
    create: async () => { output.isTTY = false; }, attach: async () => assert.fail('No owner console remains'),
    remove: async () => { calls.push('lost-console-cleanup'); } }), (error) => error.code === 'CLAUDE_OWNER_TERMINAL_REQUIRED');
  assert.equal(calls.at(-1), 'lost-console-cleanup');
});

const ticket = 'synthetic-owner-panel-grant-'.padEnd(43, 'x');
const grant = { origin: 'http://127.0.0.1:8000', ticket, expires_in: 60 };

function fixture({ platform = 'win32', inputTTY = true, outputTTY = true, receipt = grant } = {}) {
  const calls = [];
  const chunks = [];
  const options = {
    platform,
    input: { isTTY: inputTTY },
    output: { isTTY: outputTTY, write: (chunk) => chunks.push(chunk) },
    requestGrant: async () => { calls.push('grant'); return receipt; },
    launchBrowser: async (url) => { calls.push(['launch', url]); },
  };
  return { options, calls, text: () => chunks.join('') };
}

test('Windows requires owner stdin and stdout terminals before requesting a grant', async () => {
  for (const [inputTTY, outputTTY] of [[false, true], [true, false], [false, false], [undefined, true], [true, undefined], [null, true], [true, null], [1, true], [true, 1]]) {
    const current = fixture();
    current.options.input.isTTY = inputTTY;
    current.options.output.isTTY = outputTTY;
    await assert.rejects(openPanelAccess(current.options), { code: 'PANEL_OWNER_TERMINAL_REQUIRED' });
    assert.deepEqual(current.calls, []);
    assert.equal(current.text(), '');
  }
});

test('Windows prints a short-lived manual fragment link only in the owner terminal', async () => {
  const current = fixture();
  await openPanelAccess(current.options);
  assert.deepEqual(current.calls, ['grant']);
  const url = new URL(current.text().split('\n').find((line) => line.startsWith('http')));
  assert.equal(url.origin, grant.origin);
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.equal(url.hash, `#ticket=${ticket}`);
  assert.match(current.text(), /60 seconds/);
  assert.match(current.text(), /works once/);
  assert.doesNotMatch(current.text(), /Panel opened|Bearer/);
});

test('Windows does not expose a grant if its output loses TTY status while requesting it', async () => {
  const current = fixture();
  current.options.requestGrant = async () => {
    current.calls.push('grant');
    current.options.output.isTTY = false;
    return grant;
  };
  await assert.rejects(openPanelAccess(current.options), { code: 'PANEL_OWNER_TERMINAL_REQUIRED' });
  assert.deepEqual(current.calls, ['grant']);
  assert.equal(current.text(), '');
});

test('invalid origins and grants cannot reach the console or an opener', async () => {
  const origins = ['http://example.test:8000', 'http://127.0.0.1.example.test:8000', 'http://127.0.0.2:8000',
    'http://127.1:8000', 'http://2130706433:8000', 'http://user@127.0.0.1:8000',
    'http://127.0.0.1:8000/path', 'http://127.0.0.1:8000?secret=private', 'http://127.0.0.1:8000/#other',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1', 'file:///private', 'http://localhost:8000\n'];
  const receipts = [...origins.map((origin) => ({ ...grant, origin })), null, {},
    { ...grant, ticket: `${ticket}\n` }, { ...grant, ticket: 'short-private-ticket' },
    { ...grant, expires_in: 3600 }, { ...grant, expires_in: undefined }];
  for (const platform of ['win32', 'linux']) {
    for (const receipt of receipts) {
      const current = fixture({ platform, receipt });
      await assert.rejects(openPanelAccess(current.options), (error) => {
        assert.equal(error.code, 'PANEL_GRANT_INVALID');
        assert.doesNotMatch(error.message, /private|ticket|synthetic-owner/);
        return true;
      });
      assert.deepEqual(current.calls, ['grant']);
      assert.equal(current.text(), '');
    }
  }
});

test('Linux keeps browser delivery without printing the grant, even without a TTY', async () => {
  for (const origin of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000', 'https://localhost:8443']) {
    const current = fixture({ platform: 'linux', inputTTY: false, outputTTY: false, receipt: { ...grant, origin } });
    await openPanelAccess(current.options);
    assert.deepEqual(current.calls, ['grant', ['launch', `${origin}/#ticket=${ticket}`]]);
    assert.match(current.text(), /Panel opened/);
    assert.equal(current.text().includes(ticket), false);
    assert.equal(current.text().includes(origin), false);
  }
});

test('grant and opener failures expose fixed diagnostics without private details', async () => {
  for (const stage of ['requestGrant', 'launchBrowser']) {
    const current = fixture({ platform: 'linux' });
    current.options[stage] = async () => { throw new Error(`private failure ${ticket}`); };
    await assert.rejects(openPanelAccess(current.options), (error) => {
      assert.equal(error.code, stage === 'requestGrant' ? 'PANEL_UNAVAILABLE' : 'PANEL_LAUNCH_FAILED');
      assert.equal(error.message.includes(ticket), false);
      assert.equal(error.message.includes('private failure'), false);
      return true;
    });
    assert.equal(current.text(), '');
  }
  const current = fixture();
  current.options.output.write = () => { throw new Error(`private output failure ${ticket}`); };
  await assert.rejects(openPanelAccess(current.options), (error) => error.code === 'PANEL_OUTPUT_UNAVAILABLE'
    && !error.message.includes(ticket) && !error.message.includes('private output failure'));
  assert.deepEqual(current.calls, ['grant']);
});

test('the operations launcher has no PowerShell or ShellExecute opener', () => {
  assert.doesNotMatch(readFileSync(new URL('./ops.mjs', import.meta.url), 'utf8'), /powershell|ShellExecute|Start-Process/i);
});
