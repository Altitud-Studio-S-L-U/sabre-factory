import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { docker, createDatabaseFixture, provisionBootstrap, readPrivate, controlEnvironment, root, rawSecretNames, safeEnvironment } from './bootstrap.mjs';
import './executor-state-check.mjs';

const forwarded = safeEnvironment({ SABRE_AUTH_TOKEN: 'synthetic-child-env-key',
  SABRE_ROLE_MODELS: '{"developer":{"model_api_key":"synthetic-child-env-key","model_name":"fixture"}}' });
if (Object.keys(forwarded).some((name) => rawSecretNames.has(name.toUpperCase())) || JSON.stringify(forwarded).includes('synthetic-child-env-key')) {
  throw new Error('Child environment retained a private configuration value');
}
let invalidRejected = false;
try { safeEnvironment({ SABRE_ROLE_MODELS: '{"model_api_key":"synthetic-invalid-json-key",' }); }
catch (error) { invalidRejected = !String(error).includes('synthetic-invalid-json-key'); }
if (!invalidRejected) throw new Error('Invalid private JSON was not rejected without disclosing its input');

const owner = `sabre-factory-bootstrap-check-${process.pid}`;
const tag = `${owner}:local`;
const fixture = await createDatabaseFixture(owner, 10001);
let tagged = false;
let phase = 'repeated private-file provisioning';
try {
  await docker(['image', 'tag', 'sabre-factory-dev:local', tag]); tagged = true;
  const original = await readPrivate(fixture.bootstrap, 'control.json');
  const master = await readPrivate(fixture.bootstrap, 'master.key');
  await provisionBootstrap({ names: { control: fixture.bootstrap, postgres: `${owner}-pg-bootstrap` }, host: fixture.pg });
  if (!(await readPrivate(fixture.bootstrap, 'control.json')).equals(original) || !(await readPrivate(fixture.bootstrap, 'master.key')).equals(master)) {
    throw new Error('Repeated bootstrap provisioning rotated protected credentials');
  }
  const legacy = { SABRE_MODEL_PROVIDER: 'openai', SABRE_MODEL_API_KEY: 'synthetic-migration-model-key',
    SABRE_GITHUB_TOKEN: 'synthetic-migration-github-publish', SABRE_GITHUB_READ_TOKEN: 'synthetic-migration-github-read',
    SABRE_SLACK_BOT_TOKEN: 'synthetic-migration-slack-bot', SABRE_SLACK_APP_TOKEN: 'synthetic-migration-slack-app',
    SABRE_ROLE_MODELS: JSON.stringify({ developer: { model_api_key: 'synthetic-role-migration-key' }, reviewer: { model_api_key: '' }, qa: { model_api_key: null } }),
    SABRE_MCP_SERVERS: JSON.stringify({ fixture: { endpoint: 'https://example.invalid/mcp/', token: 'synthetic-migration-mcp-token', tools: {} } }) };
  const command = (name) => ['run', '--name', name, '-i', '--network', fixture.network, '--user', '10001:10001',
    '--read-only', '--memory', '256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${fixture.bootstrap}:/run/secrets/sabre:ro`, ...controlEnvironment, tag, 'python', '-I', '-c'];
  const source = readFileSync(resolve(root, 'infra/import-legacy.py'), 'utf8');
  for (const attempt of [1, 2]) {
    phase = `encrypted import ${attempt}`;
    const name = `${owner}-import-${attempt}`;
    try {
      const result = JSON.parse((await docker([...command(name), source], JSON.stringify(legacy))).toString());
      if (result.imported !== 7 || Object.keys(result.public).some((key) => rawSecretNames.has(key))) throw new Error('Legacy import did not preserve its public contract');
      if (JSON.parse(result.public.SABRE_ROLE_MODELS).reviewer.secret_ref !== '') throw new Error('Explicit blank role credentials were not preserved');
      if ('secret_ref' in JSON.parse(result.public.SABRE_ROLE_MODELS).qa) throw new Error('A null role override disabled credential inheritance');
      const inspected = JSON.parse((await docker(['inspect', name])).toString())[0];
      if (inspected.Config.Env.some((item) => rawSecretNames.has(item.split('=')[0]) || item.includes('synthetic-migration'))) throw new Error('A private value entered Docker Config.Env');
    } finally { await docker(['rm', name]); }
  }
  const conflictName = `${owner}-conflict`;
  phase = 'conflicting import';
  let rejected = false;
  try { await docker([...command(conflictName), source], JSON.stringify({ ...legacy, SABRE_MODEL_API_KEY: 'different-synthetic-key' })); }
  catch { rejected = true; }
  finally { await docker(['rm', conflictName]); }
  if (!rejected) throw new Error('Migration overwrote a different existing credential');
  phase = 'destination-bound legacy alias';
  const wrongDestination = `${owner}-wrong-destination`;
  rejected = false;
  try { await docker([...command(wrongDestination), source], JSON.stringify({ ...legacy,
    SABRE_MODEL_PROVIDER: 'anthropic', OPENAI_API_KEY: 'synthetic-migration-model-key' })); }
  catch { rejected = true; }
  finally { await docker(['rm', wrongDestination]); }
  if (!rejected) throw new Error('Migration assigned an OpenAI credential to another provider');
  const check = String.raw`
import asyncio
from sabre.settings import Settings
from sabre.vault import Vault
async def main():
 cfg=Settings(); store=Vault(cfg.vault_database_url,cfg.vault_master_key_file)
 await store.initialize()
 rows=await store.list_metadata()
 assert len(rows)==7 and all(row.version==1 for row in rows)
 assert (await store.resolve('model.openai.default')).get_secret_value()=='synthetic-migration-model-key'
 async with store._connection() as conn:
  row=await(await conn.execute("SELECT ciphertext FROM vault.secrets WHERE id='model.openai.default'")).fetchone()
  assert b'synthetic-migration-model-key' not in row['ciphertext']
asyncio.run(main())
`;
  const name = `${owner}-verify`;
  phase = 'stored ciphertext and values';
  try { await docker([...command(name), check]); }
  finally { await docker(['rm', name]); }
  console.log('Verified repeatable private bootstrap, idempotent encrypted migration, conflict protection and secret-free Config.Env.');
} catch {
  throw new Error(`Private bootstrap verification failed during ${phase}; no private output was logged`);
} finally {
  await fixture.cleanup();
  if (tagged) await docker(['image', 'rm', tag]);
}
