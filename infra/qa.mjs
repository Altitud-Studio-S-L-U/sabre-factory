import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker, createDatabaseFixture, privateJson, safeEnvironment } from './bootstrap.mjs';
import { openPanelAccess, launchWithOpener, panelLink } from './ops.mjs';
import { buildId } from '../web/scripts/build-id.mjs';

const owner = 'sabre-factory-browser-qa';
const api = `${owner}-api`;
// Loopback publishing needs a non-internal network; QA owns its own instead of joining production outbound.
const publish = `${owner}-publish`;
const address = 'http://127.0.0.1:8001';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const action = process.argv[2] ?? 'up';

async function launchApi() {
  await docker(['run', '-d', '--name', api, '--label', 'sabre.owner=factory', '--label', 'sabre.kind=browser-qa',
    '--network', owner, '--publish', '127.0.0.1:8001:8000', '--memory', '512m', '--cpus', '1', '--read-only',
    '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${owner}-bootstrap:/run/secrets/sabre:ro`, '-e', 'SABRE_BOOTSTRAP_FILE=/run/secrets/sabre/control.json',
    '-e', 'SABRE_VAULT_MASTER_KEY_FILE=/run/secrets/sabre/master.key', '-e', 'SABRE_DATA_DIR=/tmp/sabre',
    '-e', `SABRE_ALLOWED_ORIGINS=["${address}"]`, '-e', `SABRE_PANEL_ORIGIN=${address}`, 'sabre-factory-api:local']);
  await docker(['network', 'connect', publish, api]);
}

async function ensurePublishNetwork() {
  const names = new Set((await docker(['network', 'ls', '--format', '{{.Name}}'])).toString().trim().split('\n'));
  if (names.has(publish)) await assertOwned('network', publish);
  else await docker(['network', 'create', '--label', 'sabre.owner=factory', '--label', 'sabre.kind=browser-qa', publish]);
}

const grantProgram = String.raw`
import json,urllib.request
from sabre.settings import Settings
try:
 cfg=Settings()
 request=urllib.request.Request('http://127.0.0.1:8000/api/v1/panel/session-ticket',method='POST',headers={'Authorization':'Bearer '+cfg.auth_token.get_secret_value()})
 with urllib.request.urlopen(request,timeout=10) as response: print(json.dumps(json.load(response)))
except Exception:
 print(json.dumps({'error':'PANEL_UNAVAILABLE'}))
`;

const requestGrant = async () => privateJson((await docker(['exec', api, 'python', '-I', '-c', grantProgram])).toString());

async function openQaPanel() {
  await openPanelAccess({ requestGrant, launchBrowser: (relay) => launchWithOpener(relay) });
}

/**
 * Browser journeys against the fixture: the console as the application serves it, the real API and a
 * real PostgreSQL, with no model provider. The pairing link carries a one-use ticket; it reaches the
 * browser through the environment of the test process and is never printed or passed as an argument.
 */
async function checkConsole(args) {
  // The journeys describe this tree: an image built from another one passes or fails for the wrong reasons.
  let served;
  try { served = (await (await fetch(`${address}/build.json`)).json()).build; } catch { /* Reported below. */ }
  const expected = buildId();
  if (served !== expected) {
    console.error(`The fixture serves console build ${served ?? 'unknown'} and this tree is ${expected}. Run sabre build api, then node infra/qa.mjs refresh.`);
    return 2;
  }
  const link = panelLink(await requestGrant());
  const child = spawn(process.execPath, [resolve(web, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '--config', 'playwright.real.config.ts', ...args],
    { cwd: web, windowsHide: true, stdio: 'inherit', env: { ...safeEnvironment(), SABRE_REAL_URL: address, SABRE_REAL_PAIRING: link } });
  return new Promise((ok, fail) => { child.once('error', fail); child.once('close', (code) => ok(code ?? 1)); });
}

async function assertOwned(kind, name) {
  const result = JSON.parse((await docker([kind, 'inspect', name])).toString())[0];
  const labels = result.Labels ?? result.Config?.Labels;
  if (labels?.['sabre.owner'] !== 'factory') throw new Error('QA cleanup refused a resource with another owner');
}

if (action === 'up') {
  // A fresh random owner credential per fixture; it stays inside the QA bootstrap volume.
  const fixture = await createDatabaseFixture(owner, 10001, 'sabre-factory-postgres:local', { SABRE_AUTH_TOKEN: randomBytes(32).toString('base64url') });
  let created = false;
  try {
    await ensurePublishNetwork();
    await launchApi();
    created = true;
    // A non-internal network is needed for Docker's loopback port publishing; there is no provider key.
    let ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      try { await docker(['exec', api, 'python', '-I', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)"]); ready = true; break; }
      catch { await new Promise((ok) => setTimeout(ok, 1000)); }
    }
    if (!ready) throw new Error('QA API did not become ready');
    console.log(`Isolated QA available at ${address}. Pair a browser with node infra/qa.mjs open, or run the journeys with node infra/qa.mjs check.`);
  } catch (error) {
    if (created) await docker(['rm', '-f', api]);
    await fixture.cleanup();
    throw error;
  }
} else if (action === 'open') {
  await assertOwned('container', api);
  await openQaPanel();
} else if (action === 'check') {
  await assertOwned('container', api);
  process.exitCode = await checkConsole(process.argv.slice(3));
} else if (action === 'refresh') {
  await assertOwned('container', api);
  await docker(['rm', '-f', api]);
  await ensurePublishNetwork();
  await launchApi();
  console.log('QA API refreshed; database, bootstrap and master key preserved.');
} else if (action === 'restart') {
  await assertOwned('container', api);
  await docker(['restart', api]);
  console.log('QA API restarted; database and master key preserved.');
} else if (action === 'down') {
  const inventories = { container: ['ps', '-a', '--format', '{{.Names}}'], network: ['network', 'ls', '--format', '{{.Name}}'], volume: ['volume', 'ls', '--format', '{{.Name}}'] };
  const planned = [['container', api], ['container', `${owner}-postgres`], ['network', owner], ['network', publish],
    ...[`${owner}-data`, `${owner}-bootstrap`, `${owner}-pg-bootstrap`].map((name) => ['volume', name])];
  const present = {};
  for (const [kind, args] of Object.entries(inventories)) present[kind] = new Set((await docker(args)).toString().trim().split('\n'));
  const selected = planned.filter(([kind, name]) => present[kind].has(name));
  // Check all ownership before removing anything, and allow cleanup to resume after an interruption.
  for (const [kind, name] of selected) await assertOwned(kind, name);
  for (const [kind, name] of selected) await docker(kind === 'container' ? ['rm', '-f', name] : [kind, 'rm', name]);
  console.log('Isolated QA removed; the main instance is untouched.');
} else throw new Error('Use up, open, check, refresh, restart or down');
