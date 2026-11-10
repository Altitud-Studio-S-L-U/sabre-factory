import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupImageReference } from './image-identity.mjs';
import { safeEnvironment, createDatabaseFixture, controlEnvironment, volumes as bootstrapVolumes } from './bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backups = resolve(root, 'work/backups');
const [action = 'backup', requested, confirmation] = process.argv.slice(2);
const stamp = `${Date.now()}-${process.pid}`;
const folder = resolve(requested ?? resolve(backups, stamp));
if (!folder.startsWith(backups + sep)) throw new Error('Backups must stay in this checkout’s work/backups directory');
const windows = process.platform === 'win32';
import { executable, prefix } from './platform.mjs';
const volumes = { artifacts: 'sabre-factory_sabre-data', broker: 'sabre-factory_executor-state' };
const services = new Set(['api', 'worker', 'control', 'slack', 'executor']);
const pg = 'sabre-factory-postgres-1';

function start(args, stdio = ['ignore', 'pipe', 'pipe']) {
  return spawn(executable, [...prefix, ...args], { windowsHide: true, cwd: root, env: safeEnvironment(), stdio });
}
function done(child) {
  return new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveDone() : reject(new Error(`Docker operation failed (${code}); backup/restore was not accepted`)));
  });
}
async function docker(args, input) {
  const child = start(args, [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']);
  const output = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.resume();
  if (input !== undefined) child.stdin.end(input);
  await done(child);
  return Buffer.concat(output).toString('utf8').trim();
}
async function outputFile(args, path) {
  const child = start(args);
  child.stderr.resume();
  const file = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  child.stdout.pipe(file);
  await Promise.all([done(child), new Promise((ok, fail) => { file.once('finish', ok); file.once('error', fail); })]);
}
async function inputFile(args, path) {
  const child = start(args, ['pipe', 'pipe', 'pipe']);
  child.stdout.resume(); child.stderr.resume();
  const file = createReadStream(path);
  file.pipe(child.stdin);
  await Promise.all([done(child), new Promise((ok, fail) => { file.once('end', ok); file.once('error', fail); })]);
}
async function hash(path) {
  const sum = createHash('sha256');
  for await (const part of createReadStream(path)) sum.update(part);
  return sum.digest('hex');
}
async function quiesce() {
  const rows = await docker(['ps', '--filter', 'label=com.docker.compose.project=sabre-factory',
    '--format', '{{.ID}} {{.Label "com.docker.compose.service"}}']);
  const ids = rows.split('\n').filter(Boolean).map((row) => row.split(' '))
    .filter(([, name]) => services.has(name)).map(([id]) => id);
  if (ids.length) await docker(['stop', '--time', '30', ...ids]);
  const commands = await docker(['ps', '--filter', 'label=sabre.owner=factory', '--filter',
    'label=sabre.kind=command', '--format', '{{.ID}}']);
  if (commands) {
    if (ids.length) await docker(['start', ...ids]);
    throw new Error('Pause work and wait for active tool commands before taking a backup');
  }
  return ids;
}
const counts = "SELECT (SELECT count(*) FROM work_orders),(SELECT count(*) FROM work_orders WHERE data->>'status'='waiting_input'),(SELECT count(*) FROM checkpoints);";
async function databaseCounts(container) {
  return docker(['exec', container, 'psql', '-U', 'sabre_admin', '-d', 'sabre', '-Atc', counts]);
}
async function vaultFingerprint(container) {
  return docker(['exec', container, 'psql', '-U', 'sabre_admin', '-d', 'sabre_vault', '-Atc',
    "SELECT md5(coalesce((SELECT string_agg(id||'|'||version::text||'|'||configured::text||'|'||coalesce(encode(nonce,'hex'),'')||'|'||coalesce(encode(ciphertext,'hex'),''),'#' ORDER BY id) FROM vault.secrets),'')||'|'||(SELECT encode(nonce,'hex')||encode(ciphertext,'hex') FROM vault.master_check WHERE singleton));"]);
}
function archiveArgs(helper, name, volume) {
  return ['run', '--rm', '--name', name, '--network', 'none', '--read-only', '--user', '0:0',
    '--memory', '128m', '-v', `${volume}:/data:ro`, helper, 'tar', '--sort=name', '--mtime=@0',
    '--numeric-owner', '--format=ustar', '-C', '/data', '-cf', '-', '.'];
}
async function restoreVolumes(manifest, targetVolumes, suffix) {
  for (const [key, volume] of Object.entries(targetVolumes)) {
    await inputFile(['run', '--rm', '-i', '--name', `sabre-factory-restore-${suffix}-${key}`,
      '--network', 'none', '--read-only', '--user', '0:0', '--memory', '128m',
      '-v', `${volume}:/data`, manifest.helperImage, 'tar', '-C', '/data', '-xf', '-'],
    resolve(folder, `${key}.tar`));
  }
}
async function restoreDatabase(container, sqlPath = resolve(folder, 'database.sql')) {
  await inputFile(['exec', '-i', container, 'psql', '-U', 'sabre_admin', '-d', 'sabre',
    '--single-transaction', '-v', 'ON_ERROR_STOP=1'], sqlPath);
  // Restore runs as the administrator, but application-owned tables and queue
  // functions must remain editable by the non-superuser application role.
  const ownership = String.raw`
DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='sabre_app') THEN CREATE ROLE sabre_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;
GRANT USAGE, CREATE ON SCHEMA public TO sabre_app;
SELECT format('ALTER TABLE %I.%I OWNER TO sabre_app',schemaname,tablename) FROM pg_tables WHERE schemaname='public' \gexec
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO sabre_app',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'procrastinate_%' \gexec
SELECT format('ALTER TYPE %I.%I OWNER TO sabre_app',n.nspname,t.typname) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e' \gexec
`;
  await docker(['exec', '-i', container, 'psql', '-U', 'sabre_admin', '-d', 'sabre',
    '-v', 'ON_ERROR_STOP=1'], ownership);
}

async function restoreVault(container, sqlPath = resolve(folder, 'vault.sql')) {
  await inputFile(['exec', '-i', container, 'psql', '-U', 'sabre_admin', '-d', 'sabre_vault',
    '--single-transaction', '-v', 'ON_ERROR_STOP=1'], sqlPath);
  await docker(['exec', '-i', container, 'psql', '-U', 'sabre_admin', '-d', 'sabre_vault', '-v', 'ON_ERROR_STOP=1'], String.raw`
ALTER SCHEMA vault OWNER TO sabre_vault;
SELECT format('ALTER TABLE %I.%I OWNER TO sabre_vault',schemaname,tablename) FROM pg_tables WHERE schemaname='vault' \gexec
REVOKE ALL ON SCHEMA vault FROM PUBLIC,sabre_app;
REVOKE ALL ON ALL TABLES IN SCHEMA vault FROM PUBLIC,sabre_app;
`);
}

if (action === 'backup') {
  const container = JSON.parse(await docker(['inspect', pg]))[0];
  const image = JSON.parse(await docker(['image', 'inspect', container.Config.Image]))[0];
  const platform = container.ImageManifestDescriptor?.platform;
  const selected = platform ? JSON.parse(await docker(['image', 'inspect', '--platform',
    `${platform.os}/${platform.architecture}${platform.variant ? '/' + platform.variant : ''}`, container.Config.Image]))[0] : undefined;
  const requiredDatabaseImage = backupImageReference(container, image, selected);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const ids = await quiesce();
  try {
    const helperImage = await docker(['image', 'inspect', 'sabre-factory-python:local', '--format', '{{.Id}}']);
    const databaseImage = requiredDatabaseImage;
    const runtimeImage = await docker(['image', 'inspect', 'sabre-factory-api:local', '--format', '{{.Id}}']);
    const manifest = { format: 2, createdAt: new Date().toISOString(), helperImage, databaseImage,
      runtimeImage, counts: await databaseCounts(pg), vaultFingerprint: await vaultFingerprint(pg), files: {} };
    await outputFile(['exec', pg, 'pg_dump', '-U', 'sabre_admin', '-d', 'sabre', '--clean', '--if-exists',
      '--no-owner', '--no-privileges'], resolve(folder, 'database.sql'));
    await outputFile(['exec', pg, 'pg_dump', '-U', 'sabre_admin', '-d', 'sabre_vault', '--clean', '--if-exists',
      '--no-owner', '--no-privileges'], resolve(folder, 'vault.sql'));
    for (const [key, volume] of Object.entries(volumes)) {
      await outputFile(archiveArgs(helperImage, `sabre-factory-backup-${stamp}-${key}`, volume), resolve(folder, `${key}.tar`));
    }
    for (const file of ['database.sql', 'vault.sql', 'artifacts.tar', 'broker.tar']) manifest.files[file] = await hash(resolve(folder, file));
    writeFileSync(resolve(folder, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(`Consistent backup saved in ${folder}`);
    console.log('Retain the master key, bootstrap files and referenced images separately to recover this backup.');
  } finally {
    if (ids.length) await docker(['start', ...ids]);
  }
} else if (action === 'verify' || action === 'restore') {
  if (!requested) throw new Error('Specify a backup directory');
  const manifest = JSON.parse(readFileSync(resolve(folder, 'manifest.json'), 'utf8'));
  if (manifest.format !== 2 || [manifest.helperImage, manifest.databaseImage, manifest.runtimeImage].some((image) => !/^sha256:[a-f0-9]{64}$/.test(image))) throw new Error('Unsupported backup manifest');
  for (const file of ['database.sql', 'vault.sql', 'artifacts.tar', 'broker.tar']) {
    if (await hash(resolve(folder, file)) !== manifest.files[file]) throw new Error(`Backup digest mismatch: ${file}`);
  }
  if (action === 'restore') {
    if (confirmation !== '--replace') throw new Error('Restore replaces SABRE state; pass --replace explicitly');
    const runtime = await docker(['image', 'inspect', 'sabre-factory-api:local', '--format', '{{.Id}}']);
    if (runtime !== manifest.runtimeImage) throw new Error('Restore requires the same application image; migrate separately after recovery');
    const ids = await quiesce();
    let restored = false;
    try {
      await restoreDatabase(pg);
      await restoreVault(pg);
      await restoreVolumes(manifest, volumes, stamp);
      if (await databaseCounts(pg) !== manifest.counts) throw new Error('Restored database counts differ');
      if (await vaultFingerprint(pg) !== manifest.vaultFingerprint) throw new Error('Restored encrypted vault differs');
      await docker(['run', '--rm', '--network', 'sabre-factory_control', '--read-only', '--memory', '256m', '--user', '10001:10001',
        '-v', `${bootstrapVolumes.control}:/run/secrets/sabre:ro`, ...controlEnvironment, manifest.runtimeImage,
        'python', '-I', '-c', "import asyncio; from sabre.settings import Settings; from sabre.vault import Vault\nasync def main():\n cfg=Settings(); vault=Vault(cfg.vault_database_url,cfg.vault_master_key_file); await vault.initialize()\n for row in await vault.list_metadata():\n  if row.configured: await vault.resolve(row.id)\nasyncio.run(main())"]);
      restored = true;
      console.log('State restored. Later unreferenced immutable artifacts are retained.');
    } finally {
      if (ids.length && restored) await docker(['start', ...ids]);
    }
  } else {
    const owner = `sabre-factory-restore-check-${stamp}`;
    const fixture = await createDatabaseFixture(owner, 10001, manifest.databaseImage);
    const checkPg = fixture.pg;
    const checkVolumes = Object.fromEntries(Object.keys(volumes).map((key) => [key, `${owner}-${key}`]));
    const created = [];
    try {
      for (const volume of Object.values(checkVolumes)) {
        await docker(['volume', 'create', '--label', 'sabre.owner=restore-check', volume]); created.push(volume);
      }
      await restoreDatabase(checkPg);
      await restoreVault(checkPg);
      await restoreVolumes(manifest, checkVolumes, stamp);
      if (await databaseCounts(checkPg) !== manifest.counts) throw new Error('Recovery database counts differ');
      if (await vaultFingerprint(checkPg) !== manifest.vaultFingerprint) throw new Error('Recovery encrypted vault differs');
      for (const [key, volume] of Object.entries(checkVolumes)) {
        const checked = resolve(folder, `${key}.verified-${stamp}.tar`);
        await outputFile(archiveArgs(manifest.helperImage, `${checkPg}-${key}`, volume), checked);
        if (await hash(checked) !== manifest.files[`${key}.tar`]) throw new Error(`Recovered ${key} volume differs`);
      }
      const checkpointProbe = `
import asyncio, sys
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from sabre.settings import Settings
from sabre.vault import Vault
from sabre.models import SecretUpsert
from pydantic import SecretStr
class State(TypedDict):
    answer: str
def approval(state):
    return {"answer": interrupt("Approve the isolated recovery fixture?")}
async def main():
    cfg=Settings()
    vault=Vault(cfg.vault_database_url,'/original-master/master.key')
    await vault.initialize()
    for row in await vault.list_metadata():
        if row.configured: await vault.resolve(row.id)
    fixture_id='fixture.restore.'+sys.argv[2]
    if sys.argv[1] == 'pause':
        await vault.put(fixture_id,SecretUpsert(value=SecretStr('synthetic-restored-vault-value')))
    else:
        row=next(row for row in await vault.list_metadata() if row.id==fixture_id)
        assert row.version==1 and row.configured
        assert (await vault.resolve(fixture_id)).get_secret_value()=='synthetic-restored-vault-value'
    async with AsyncPostgresSaver.from_conn_string(cfg.database_url.get_secret_value()) as saver:
        await saver.setup()
        graph = StateGraph(State).add_node("approval", approval).add_edge(START,"approval").add_edge("approval",END).compile(checkpointer=saver)
        config = {"configurable":{"thread_id":sys.argv[2]}}
        if sys.argv[1] == "pause":
            result = await graph.ainvoke({"answer":""},config,durability="sync")
            assert result.get("__interrupt__"), "HITL did not pause"
        else:
            result = await graph.ainvoke(Command(resume="approved"),config,durability="sync")
            assert result["answer"] == "approved", "HITL did not resume"
asyncio.run(main())
`;
      const probe = (phase) => docker(['run', '--rm', '--name', `${checkPg}-hitl-${phase}`,
        '--network', fixture.network, '--read-only', '--memory', '256m', '--user', '10001:10001',
        '-v', `${fixture.bootstrap}:/run/secrets/sabre:ro`, ...controlEnvironment,
        '-v', `${bootstrapVolumes.control}:/original-master:ro`,
        '--tmpfs', '/tmp:rw,size=32m', manifest.runtimeImage, '/app/.venv/bin/python', '-I', '-c',
        checkpointProbe, phase, stamp]);
      await probe('pause');
      const pausedDump = resolve(folder, `hitl-fixture-${stamp}.sql`);
      await outputFile(['exec', checkPg, 'pg_dump', '-U', 'sabre_admin', '-d', 'sabre', '--clean',
        '--if-exists', '--no-owner', '--no-privileges'], pausedDump);
      const vaultDump = resolve(folder, `vault-fixture-${stamp}.sql`);
      await outputFile(['exec', checkPg, 'pg_dump', '-U', 'sabre_admin', '-d', 'sabre_vault', '--clean',
        '--if-exists', '--no-owner', '--no-privileges'], vaultDump);
      await restoreDatabase(checkPg, pausedDump);
      await restoreVault(checkPg, vaultDump);
      await probe('resume');
      console.log('Isolated recovery verified: databases, vault decryption, checkpoints and volumes match.');
      console.log('A real LangGraph intervention was paused, dumped/restored and resumed with a response.');
      console.log('The isolated synthetic credential retained its value and version after restoration.');
    } finally {
      for (const volume of created) await docker(['volume', 'rm', volume]);
      await fixture.cleanup();
    }
  }
} else {
  throw new Error('Use backup [directory], verify <directory>, or restore <directory> --replace');
}
