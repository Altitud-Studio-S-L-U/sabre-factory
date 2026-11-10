import { docker, createDatabaseFixture } from './bootstrap.mjs';

const owner = 'sabre-factory-browser-qa';
const api = `${owner}-api`;
const action = process.argv[2] ?? 'up';
const token = 'sabre-qa-browser-fixture-20261105';

async function launchApi() {
  await docker(['run', '-d', '--name', api, '--label', 'sabre.owner=factory', '--label', 'sabre.kind=browser-qa',
    '--network', owner, '--publish', '127.0.0.1:8001:8000', '--memory', '512m', '--cpus', '1', '--read-only',
    '--tmpfs', '/tmp:rw,size=64m,mode=1777', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${owner}-bootstrap:/run/secrets/sabre:ro`, '-e', 'SABRE_BOOTSTRAP_FILE=/run/secrets/sabre/control.json',
    '-e', 'SABRE_VAULT_MASTER_KEY_FILE=/run/secrets/sabre/master.key', '-e', 'SABRE_DATA_DIR=/tmp/sabre',
    '-e', 'SABRE_ALLOWED_ORIGINS=["http://127.0.0.1:8001"]', '-e', 'SABRE_PANEL_ORIGIN=http://127.0.0.1:8001', 'sabre-factory-api:local']);
  await docker(['network', 'connect', 'sabre-factory_outbound', api]);
}

async function assertOwned(kind, name) {
  const result = JSON.parse((await docker([kind, 'inspect', name])).toString())[0];
  const labels = result.Labels ?? result.Config?.Labels;
  if (labels?.['sabre.owner'] !== 'factory') throw new Error('QA cleanup refused a resource with another owner');
}

if (action === 'up') {
  const fixture = await createDatabaseFixture(owner, 10001, 'sabre-factory-postgres:local', { SABRE_AUTH_TOKEN: token });
  let created = false;
  try {
    await launchApi();
    created = true;
    // A non-internal network is needed for Docker's loopback port publishing; there is no provider key.
    let ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      try { await docker(['exec', api, 'python', '-I', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)"]); ready = true; break; }
      catch { await new Promise((ok) => setTimeout(ok, 1000)); }
    }
    if (!ready) throw new Error('QA API did not become ready');
    console.log('Isolated QA available at http://127.0.0.1:8001; synthetic token: ' + token);
  } catch (error) {
    if (created) await docker(['rm', '-f', api]);
    await fixture.cleanup();
    throw error;
  }
} else if (action === 'refresh') {
  await assertOwned('container', api);
  await docker(['rm', '-f', api]);
  await launchApi();
  console.log('API QA actualizada; base de datos, bootstrap y master preservados.');
} else if (action === 'restart') {
  await assertOwned('container', api);
  await docker(['restart', api]);
  console.log('API QA reiniciada; la base de datos y la clave maestra se conservaron.');
} else if (action === 'down') {
  const inventories = { container: ['ps', '-a', '--format', '{{.Names}}'], network: ['network', 'ls', '--format', '{{.Name}}'], volume: ['volume', 'ls', '--format', '{{.Name}}'] };
  const planned = [['container', api], ['container', `${owner}-postgres`], ['network', owner],
    ...[`${owner}-data`, `${owner}-bootstrap`, `${owner}-pg-bootstrap`].map((name) => ['volume', name])];
  const present = {};
  for (const [kind, args] of Object.entries(inventories)) present[kind] = new Set((await docker(args)).toString().trim().split('\n'));
  const selected = planned.filter(([kind, name]) => present[kind].has(name));
  // Check all ownership before removing anything, and allow cleanup to resume after an interruption.
  for (const [kind, name] of selected) await assertOwned(kind, name);
  for (const [kind, name] of selected) await docker(kind === 'container' ? ['rm', '-f', name] : [kind, 'rm', name]);
  console.log('QA aislada retirada; la instancia principal permanece intacta.');
} else throw new Error('Use up, refresh, restart or down');
