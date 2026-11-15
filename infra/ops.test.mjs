import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { prepareScannerImages, openPanelAccess, requireClaudeOwnerTerminal, runClaudeOwnerLogin, releaseClaudeBridge,
  browserOpener, launchWithOpener, panelLink, serveHandoff, traceSettings } from './ops.mjs';

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

test('Claude login stops a bridge that serves no account and never one that does', async () => {
  const calls = [];
  const stop = async () => { calls.push('stop'); };
  assert.equal(await releaseClaudeBridge({ running: false, status: async () => assert.fail('No bridge to ask'), stop }), 'absent');
  // What up starts after prepare-claude: a bridge with nothing to protect.
  assert.equal(await releaseClaudeBridge({ running: true, status: async () => ({ authenticated: false }), stop }), 'stopped');
  assert.deepEqual(calls, ['stop']);
  // A connected subscription, or a status that cannot be read, still takes the owner's explicit stop.
  for (const status of [async () => ({ authenticated: true }), async () => ({}), async () => null,
    async () => { throw new Error('Bridge unreachable'); }]) {
    await assert.rejects(releaseClaudeBridge({ running: true, status, stop }), /stop claude-runner before changing the Claude account/);
  }
  assert.deepEqual(calls, ['stop']);
});

const ticket = 'synthetic-owner-panel-grant-'.padEnd(43, 'x');
const grant = { origin: 'http://127.0.0.1:8000', ticket, expires_in: 60 };
const relayAddress = 'http://127.0.0.1:49152/relay-path';

function fixture({ receipt = grant, delivered = true } = {}) {
  const calls = [];
  const chunks = [];
  const options = {
    output: { write: (chunk) => chunks.push(chunk) },
    requestGrant: async () => { calls.push('grant'); return receipt; },
    handoff: async (target) => {
      calls.push(['relay', target]);
      return { address: relayAddress, delivered: Promise.resolve(delivered), close: () => calls.push('relay-closed') };
    },
    launchBrowser: async (address) => { calls.push(['launch', address]); },
  };
  return { options, calls, text: () => chunks.join('') };
}

test('every platform opens the panel through the local relay without printing the grant', async () => {
  for (const origin of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000', 'https://localhost:8443']) {
    const current = fixture({ receipt: { ...grant, origin } });
    await openPanelAccess(current.options);
    assert.deepEqual(current.calls, ['grant', ['relay', `${origin}/#ticket=${ticket}`], ['launch', relayAddress]]);
    assert.match(current.text(), /Panel opened/);
    assert.equal(current.text().includes(ticket), false);
    assert.equal(current.text().includes(relayAddress), false);
  }
});

test('the opener receives only the relay address and the platform opener needs no shell', async () => {
  assert.deepEqual(browserOpener('win32'), { command: 'explorer.exe', exitCodeReliable: false });
  assert.deepEqual(browserOpener('darwin'), { command: 'open', exitCodeReliable: true });
  assert.deepEqual(browserOpener('linux'), { command: 'xdg-open', exitCodeReliable: true });
  for (const [platform, code] of [['win32', 1], ['darwin', 0], ['linux', 0]]) {
    const spawned = [];
    const spawnProcess = (command, args, options) => {
      spawned.push({ command, args, shell: options.shell });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', code));
      return child;
    };
    await launchWithOpener(relayAddress, { platform, spawnProcess });
    assert.deepEqual(spawned, [{ command: browserOpener(platform).command, args: [relayAddress], shell: undefined }]);
  }
  const failing = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 3)); return child; };
  await assert.rejects(launchWithOpener(relayAddress, { platform: 'linux', spawnProcess: failing }));
});

test('the relay redirects once to the fragment grant and then stops serving', async () => {
  const target = `${grant.origin}/#ticket=${ticket}`;
  const relay = await serveHandoff(target, { timeoutMs: 5_000 });
  const address = new URL(relay.address);
  assert.equal(address.hostname, '127.0.0.1');
  assert.match(address.pathname, /^\/[A-Za-z0-9_-]{43}$/);
  const wrong = await fetch(`${address.origin}/guess`, { redirect: 'manual' });
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get('location'), null);
  const response = await fetch(relay.address, { redirect: 'manual' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), target);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(await relay.delivered, true);
  await assert.rejects(fetch(relay.address, { redirect: 'manual' }));
});

test('an unused relay expires and reports that nothing was delivered', async () => {
  const relay = await serveHandoff('http://127.0.0.1:8000/#ticket=x', { timeoutMs: 20 });
  assert.equal(await relay.delivered, false);
  await assert.rejects(fetch(relay.address, { redirect: 'manual' }));
});

test('invalid origins and grants never reach the relay, an opener or the console', async () => {
  const origins = ['http://example.test:8000', 'http://127.0.0.1.example.test:8000', 'http://127.0.0.2:8000',
    'http://127.1:8000', 'http://2130706433:8000', 'http://user@127.0.0.1:8000',
    'http://127.0.0.1:8000/path', 'http://127.0.0.1:8000?secret=private', 'http://127.0.0.1:8000/#other',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1', 'file:///private', 'http://localhost:8000\n'];
  const receipts = [...origins.map((origin) => ({ ...grant, origin })), null, {},
    { ...grant, ticket: `${ticket}\n` }, { ...grant, ticket: 'short-private-ticket' },
    { ...grant, expires_in: 3600 }, { ...grant, expires_in: undefined }];
  for (const receipt of receipts) {
    const current = fixture({ receipt });
    await assert.rejects(openPanelAccess(current.options), (error) => {
      assert.equal(error.code, 'PANEL_GRANT_INVALID');
      assert.doesNotMatch(error.message, /private|ticket|synthetic-owner/);
      return true;
    });
    assert.deepEqual(current.calls, ['grant']);
    assert.equal(current.text(), '');
  }
});

test('grant, relay, opener and delivery failures expose fixed diagnostics without private details', async () => {
  for (const stage of ['requestGrant', 'handoff', 'launchBrowser']) {
    const current = fixture();
    current.options[stage] = async () => { throw new Error(`private failure ${ticket}`); };
    await assert.rejects(openPanelAccess(current.options), (error) => {
      assert.equal(error.code, stage === 'requestGrant' ? 'PANEL_UNAVAILABLE' : 'PANEL_LAUNCH_FAILED');
      assert.equal(error.message.includes(ticket), false);
      assert.equal(error.message.includes('private failure'), false);
      return true;
    });
    assert.equal(current.text(), '');
    if (stage === 'launchBrowser') assert.equal(current.calls.at(-1), 'relay-closed');
  }
  const undelivered = fixture({ delivered: false });
  await assert.rejects(openPanelAccess(undelivered.options), (error) => error.code === 'PANEL_LAUNCH_FAILED' && /60 seconds/.test(error.message));
  assert.equal(undelivered.text(), '');
  const closedTerminal = fixture();
  closedTerminal.options.output.write = () => { throw new Error(`private output failure ${ticket}`); };
  await openPanelAccess(closedTerminal.options);
});

test('the pairing link of the browser journeys is a validated grant and travels only in the environment', () => {
  assert.equal(panelLink(grant), `${grant.origin}/#ticket=${ticket}`);
  assert.throws(() => panelLink({ ...grant, origin: 'http://example.test:8000' }), (error) => error.code === 'PANEL_GRANT_INVALID');
  // In the QA launcher the link is defined once and used once, as an environment entry of the test
  // process: never an argument, which other processes can read, and never a printed line.
  const source = readFileSync(new URL('./qa.mjs', import.meta.url), 'utf8');
  const uses = source.split('\n').filter((line) => /\blink\b/.test(line) && !/^\s*(\*|\/\/)/.test(line));
  assert.equal(uses.length, 2, uses.join('\n'));
  assert.match(uses[0], /const link = panelLink\(await requestGrant\(\)\);/);
  assert.match(uses[1], /env: \{[^}]*SABRE_REAL_PAIRING: link \}/);
});

test('the operations launcher has no PowerShell or ShellExecute opener', () => {
  assert.doesNotMatch(readFileSync(new URL('./ops.mjs', import.meta.url), 'utf8'), /powershell|ShellExecute|Start-Process/i);
});


test('security preparation pulls rendered immutable scanners before execution', async () => {
  const names = ['SABRE_GITLEAKS_IMAGE', 'SABRE_SEMGREP_IMAGE', 'SABRE_TRIVY_IMAGE'];
  const images = names.map((name, index) => `registry.example/${name.toLowerCase()}:v1@sha256:${String(index).repeat(64)}`);
  const calls = [];
  await prepareScannerImages({ services: { executor: { environment: Object.fromEntries(names.map((name, index) => [name, images[index]])) } } }, async (image) => calls.push(image));
  assert.deepEqual(calls, images);
  for (const invalid of [undefined, 'scanner:latest', `scanner@sha256:${'x'.repeat(64)}`]) {
    const environment = Object.fromEntries(names.map((name, index) => [name, images[index]]));
    environment.SABRE_TRIVY_IMAGE = invalid;
    await assert.rejects(prepareScannerImages({ services: { executor: { environment } } }, async () => assert.fail('Validation must precede every pull')), /digest-pinned/);
  }
  await assert.rejects(prepareScannerImages({}, async () => assert.fail()), /digest-pinned/);
});

test('up --traces points the services at the bundled viewer and keeps what the operator configured', () => {
  assert.deepEqual(traceSettings({}, false), {});
  assert.deepEqual(traceSettings({ SABRE_OTLP_ENDPOINT: '' }, true), {
    SABRE_OTLP_ENDPOINT: 'http://jaeger:4318/v1/traces',
    SABRE_TRACE_VIEWER_URL: 'http://127.0.0.1:16686/trace/{trace_id}',
  });
  const own = { SABRE_OTLP_ENDPOINT: 'https://collector.example/v1/traces', SABRE_TRACE_VIEWER_URL: 'https://traces.example/t/{trace_id}' };
  assert.deepEqual(traceSettings(own, true), own);
  // The viewer listens on the loopback interface only, and the endpoint is the service's name on the control network.
  const compose = readFileSync(new URL('./compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /jaeger:\n\s+profiles: \[telemetry\][\s\S]*?ports: \["127\.0\.0\.1:16686:16686"\]/);
  assert.match(compose, /SABRE_TRACE_VIEWER_URL: \$\{SABRE_TRACE_VIEWER_URL:-\}/);
});
