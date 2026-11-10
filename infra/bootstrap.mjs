import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const windows = process.platform === 'win32';
import { executable, prefix } from './platform.mjs';
export { executable, prefix };
export const volumes = {
  control: 'sabre-factory-control-bootstrap', broker: 'sabre-factory-broker-bootstrap',
  gateway: 'sabre-factory-gateway-bootstrap', postgres: 'sabre-factory-postgres-bootstrap',
};
export const rawSecretNames = new Set([
  'SABRE_DATABASE_URL', 'SABRE_VAULT_DATABASE_URL', 'SABRE_AUTH_TOKEN', 'SABRE_EXECUTOR_TOKEN', 'SABRE_GATEWAY_TOKEN',
  'SABRE_MODEL_API_KEY', 'SABRE_GITHUB_TOKEN', 'SABRE_GITHUB_READ_TOKEN', 'SABRE_SLACK_BOT_TOKEN', 'SABRE_SLACK_APP_TOKEN',
  'SABRE_DB_PASSWORD', 'SABRE_DB_ADMIN_PASSWORD', 'SABRE_VAULT_PASSWORD', 'SABRE_VAULT_MASTER_KEY',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN',
  'LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY',
  'SABRE_CLAUDE_CLI_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
]);
const python = 'python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527';

export function privateJson(value) {
  try { return JSON.parse(value); }
  catch { throw new Error('Private configuration is not valid JSON; no value was logged'); }
}

export function safeEnvironment(publicConfig = {}) {
  const result = { ...process.env };
  for (const key of Object.keys(result)) if (rawSecretNames.has(key.toUpperCase())) delete result[key];
  for (const [key, value] of Object.entries(publicConfig)) if (!rawSecretNames.has(key)) result[key] = value;
  for (const name of ['SABRE_ROLE_MODELS', 'SABRE_MCP_SERVERS']) {
    if (!result[name]) continue;
    const entries = privateJson(result[name]);
    if (!entries || Array.isArray(entries) || typeof entries !== 'object' || Object.values(entries).some((item) => !item || Array.isArray(item) || typeof item !== 'object')) {
      throw new Error('Public role and MCP configuration must be objects with valid entries');
    }
    for (const item of Object.values(entries)) for (const key of ['model_api_key', 'api_key', 'token', 'headers']) delete item[key];
    result[name] = JSON.stringify(entries);
  }
  for (const key of ['LANGSMITH_TRACING', 'LANGCHAIN_TRACING_V2', 'LANGCHAIN_TRACING']) delete result[key];
  // WSLENV is replaced, not extended: inherited forwarding must not reintroduce secrets.
  if (windows) result.WSLENV = Object.keys(publicConfig).filter((key) => !rawSecretNames.has(key)).join(':');
  return result;
}

export async function docker(args, input, environment = safeEnvironment(), includeStderr = false) {
  const child = spawn(executable, [...prefix, ...args], { cwd: root, windowsHide: true, env: environment,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const output = [];
  child.stdout.on('data', (part) => output.push(part));
  // Commands may handle private files/SQL. Never echo their stderr or arguments.
  if (includeStderr) child.stderr.on('data', (part) => output.push(part));
  else child.stderr.resume();
  if (input !== undefined) child.stdin.end(input);
  await new Promise((ok, fail) => {
    child.once('error', () => fail(new Error('Docker bootstrap operation could not start')));
    child.once('close', (code) => code === 0 ? ok() : fail(new Error(`Docker bootstrap operation failed (${code})`)));
  });
  return Buffer.concat(output);
}

export async function ownedVolume(name, kind = 'bootstrap') {
  try {
    const rows = JSON.parse((await docker(['volume', 'inspect', name])).toString());
    if (rows[0].Labels?.['sabre.owner'] !== 'factory' || rows[0].Labels?.['sabre.kind'] !== kind) {
      throw new Error('The requested volume is not owned by this reconstruction');
    }
    return;
  } catch (error) {
    if (!error.message.startsWith('Docker bootstrap operation failed')) throw error;
  }
  await docker(['volume', 'create', '--label', 'sabre.owner=factory', '--label', `sabre.kind=${kind}`, name]);
}

export async function readPrivate(volume, name) {
  await ownedVolume(volume);
  const program = "import pathlib,sys; p=pathlib.Path('/private')/sys.argv[1]; sys.stdout.buffer.write(p.read_bytes())";
  return docker(['run', '--rm', '--network', 'none', '--read-only', '--memory', '64m', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE',
    '-v', `${volume}:/private:ro`, python, 'python', '-I', '-c', program, name]);
}

async function optionalPrivate(volume, name) {
  await ownedVolume(volume);
  const program = "import pathlib,sys,base64,json; p=pathlib.Path('/private')/sys.argv[1]; print(json.dumps(base64.b64encode(p.read_bytes()).decode() if p.exists() else None))";
  const encoded = JSON.parse((await docker(['run', '--rm', '--network', 'none', '--read-only', '--memory', '64m',
    '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '-v', `${volume}:/private:ro`, python, 'python', '-I', '-c', program, name])).toString());
  return encoded === null ? null : Buffer.from(encoded, 'base64');
}

export function privateTar(files, uid) {
  const parts = [];
  for (const [name, value] of Object.entries(files)) {
    if (!/^[a-z][a-z0-9.]*$/.test(name)) throw new Error('Invalid bootstrap filename');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'ascii');
    const octal = (number, offset, length) => header.write(number.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    octal(0o400, 100, 8); octal(uid, 108, 8); octal(uid, 116, 8); octal(data.length, 124, 12); octal(0, 136, 12);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    parts.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

export async function writePrivate(volume, files, uid) {
  await ownedVolume(volume);
  const program = String.raw`
import os,pathlib,sys,tarfile
base=pathlib.Path('/private')
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
 for item in archive:
  if not item.isfile() or '/' in item.name or item.name not in sys.argv[1:]: raise SystemExit(2)
  value=archive.extractfile(item).read()
  path=base/item.name
  if path.exists():
   if path.is_symlink() or path.read_bytes()!=value: raise SystemExit(3)
  else:
   fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
   with os.fdopen(fd,'wb') as stream: stream.write(value); stream.flush(); os.fsync(stream.fileno())
  os.chmod(path,0o400); os.chown(path,item.uid,item.gid)
`;
  await docker(['run', '--rm', '-i', '--network', 'none', '--read-only', '--memory', '64m', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '-v', `${volume}:/private`, python,
    'python', '-I', '-c', program, ...Object.keys(files)], privateTar(files, uid));
}

export async function provisionBootstrap({ names = volumes, host = 'postgres', uid = 10001, legacy = {} } = {}) {
  const hex = () => randomBytes(32).toString('hex');
  const oldControl = await optionalPrivate(names.control, 'control.json');
  const oldMaster = await optionalPrivate(names.control, 'master.key');
  if (oldControl && !oldMaster) throw new Error('Existing control bootstrap has lost its master key; recover that file before continuing');
  const pg = {};
  for (const name of ['admin', 'app', 'vault']) {
    const old = await optionalPrivate(names.postgres, `${name}.password`);
    pg[name] = old?.toString() || legacy[{ admin: 'SABRE_DB_ADMIN_PASSWORD', app: 'SABRE_DB_PASSWORD', vault: 'SABRE_VAULT_PASSWORD' }[name]] || hex();
  }
  const master = oldMaster ?? randomBytes(32);
  const control = oldControl ? privateJson(oldControl.toString()) : { format: 1,
    database_url: `postgresql://sabre_app:${encodeURIComponent(pg.app)}@${host}:5432/sabre`,
    vault_database_url: `postgresql://sabre_vault:${encodeURIComponent(pg.vault)}@${host}:5432/sabre_vault`,
    auth_token: legacy.SABRE_AUTH_TOKEN || hex(), executor_token: legacy.SABRE_EXECUTOR_TOKEN || hex(), gateway_token: hex() };
  if (oldControl) {
    for (const [key, value] of [['SABRE_DB_ADMIN_PASSWORD', pg.admin], ['SABRE_DB_PASSWORD', pg.app],
      ['SABRE_AUTH_TOKEN', control.auth_token], ['SABRE_EXECUTOR_TOKEN', control.executor_token]]) {
      if (legacy[key] && legacy[key] !== value) throw new Error('Bootstrap credentials disagree with legacy configuration; migration stopped');
    }
  }
  if (master.length !== 32 || control.format !== 1) throw new Error('Existing bootstrap files are invalid');
  if (control.database_url !== `postgresql://sabre_app:${encodeURIComponent(pg.app)}@${host}:5432/sabre` ||
      control.vault_database_url !== `postgresql://sabre_vault:${encodeURIComponent(pg.vault)}@${host}:5432/sabre_vault`) {
    throw new Error('Database credentials disagree with the protected bootstrap; recovery is required');
  }
  await writePrivate(names.postgres, Object.fromEntries(Object.entries(pg).map(([name, value]) => [`${name}.password`, value])), 999);
  await writePrivate(names.control, { 'master.key': master, 'control.json': JSON.stringify(control) }, uid);
  if (names.broker) await writePrivate(names.broker, { 'broker.json': JSON.stringify({ format: 1, executor_token: control.executor_token }) }, 0);
  if (names.gateway) await writePrivate(names.gateway, { 'gateway.json': JSON.stringify({ format: 1, gateway_token: control.gateway_token }) }, 10001);
  return { control, pg };
}

export function postgresEnvironment() {
  return ['-e', 'POSTGRES_DB=sabre', '-e', 'POSTGRES_USER=sabre_admin', '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/postgres/admin.password',
    '-e', 'PGDATA=/var/lib/postgresql/18/docker'];
}

export const controlEnvironment = ['-e', 'SABRE_BOOTSTRAP_FILE=/run/secrets/sabre/control.json',
  '-e', 'SABRE_VAULT_MASTER_KEY_FILE=/run/secrets/sabre/master.key'];

export async function waitPostgres(name) {
  for (let attempt = 0; attempt < 90; attempt++) {
    try { await docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'sabre_admin', '-d', 'sabre']); return; }
    catch { await new Promise((ok) => setTimeout(ok, 1000)); }
  }
  throw new Error('Isolated PostgreSQL did not become ready');
}

export async function createDatabaseFixture(owner, uid = 0, databaseImage = 'sabre-factory-postgres:local', legacy = {}) {
  if (!/^sabre-factory-[a-z0-9-]+$/.test(owner)) throw new Error('Invalid isolated fixture name');
  const names = { control: `${owner}-bootstrap`, postgres: `${owner}-pg-bootstrap` };
  const pg = `${owner}-postgres`;
  const data = `${owner}-data`;
  const resources = [];
  let createdNetwork = false;
  let createdContainer = false;
  const cleanup = async () => {
    if (createdContainer) await docker(['rm', '-f', pg]);
    if (createdNetwork) await docker(['network', 'rm', owner]);
    for (const name of resources.reverse()) await docker(['volume', 'rm', name]);
  };
  try {
    for (const [kind, name] of [['network', owner], ['container', pg], ...[...Object.values(names), data].map((name) => ['volume', name])]) {
      let present = false;
      try { await docker([kind, 'inspect', name]); present = true; }
      catch (error) { if (!error.message.startsWith('Docker bootstrap operation failed')) throw error; }
      if (present) throw new Error('An isolated fixture resource already exists; inspect it before starting a new fixture');
    }
    for (const name of [...Object.values(names), data]) { await ownedVolume(name); resources.push(name); }
    await provisionBootstrap({ names, host: pg, uid, legacy });
    await docker(['network', 'create', '--internal', '--label', 'sabre.owner=factory', owner]); createdNetwork = true;
    await docker(['run', '-d', '--name', pg, '--label', 'sabre.owner=factory', '--label', 'sabre.kind=database-fixture',
      '--network', owner, '--memory', '512m', '--cpus', '1',
      ...postgresEnvironment(), '-v', `${data}:/var/lib/postgresql`,
      '-v', `${names.postgres}:/run/secrets/postgres:ro`, databaseImage]); createdContainer = true;
    await waitPostgres(pg);
    return { network: owner, pg, bootstrap: names.control, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
