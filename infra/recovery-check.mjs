import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeEnvironment, createDatabaseFixture, controlEnvironment } from './bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
import { executable, prefix } from './platform.mjs';
const owner = `sabre-factory-recovery-${process.pid}`;
const tag = `${owner}:local`;
const network = owner;
const worker = `${owner}-worker`;
const control = `${owner}-control`;
const api = `${owner}-api`;
const env = [...controlEnvironment, '-v', `${owner}-bootstrap:/run/secrets/sabre:ro`, '-e', 'SABRE_DATA_DIR=/tmp/sabre'];
const containers = [];
let imageBuilt = false;
let fixture;

function start(command, args, stdio = ['ignore', 'pipe', 'pipe']) {
  return spawn(command, args, { cwd: root, windowsHide: true, env: safeEnvironment(), stdio });
}
function done(child) {
  return new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', (code) => code === 0 ? ok() : fail(new Error(`Recovery operation failed (${code})`)));
  });
}
async function docker(args, includeStderr = false, quiet = false) {
  const child = start(executable, [...prefix, ...args]);
  const output = [], errors = [];
  child.stdout.on('data', (part) => output.push(part));
  child.stderr.on('data', (part) => errors.push(part));
  try { await done(child); }
  catch (error) {
    const details = Buffer.concat(errors).toString('utf8').trim();
    if (details && !quiet) console.error(details);
    throw error;
  }
  return Buffer.concat(includeStderr ? [...output, ...errors] : output).toString('utf8').trim();
}
async function build() {
  const archive = start(windows ? 'tar.exe' : 'tar', [
    '--exclude=.git', '--exclude=work', '--exclude=.env', '--exclude=.env.*', '--exclude=.sabre', '--exclude=node_modules',
    '--exclude=.venv', '--exclude=__pycache__', '--exclude=dist', '--exclude=.pytest_cache', '--exclude=.ruff_cache', '-cf', '-', '.',
  ], ['ignore', 'pipe', 'inherit']);
  const builder = start(executable, [...prefix, 'build', '--target', 'dev', '-f', 'infra/Dockerfile.backend', '-t', tag, '-'], ['pipe', 'inherit', 'inherit']);
  archive.stdout.pipe(builder.stdin);
  await Promise.all([done(archive), done(builder)]);
}
async function run(name, command, detached = false) {
  if (detached) containers.push(name);
  return docker(['run', detached ? '-d' : '--rm', '--name', name, '--network', network,
    '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--memory', '384m', '--cpus', '1',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', ...env, tag, ...command]);
}
async function probe(action) {
  const output = await run(`${owner}-${action}`, ['/app/.venv/bin/python', '-m', 'integration.worker_probe', action]);
  return output ? JSON.parse(output.split('\n').at(-1)) : null;
}
async function until(predicate, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  throw new Error('Recovery observation deadline exceeded');
}
async function queryStatus(workId) {
  const program = "import json,time,urllib.request,sys; from sabre.settings import Settings; t=time.monotonic(); r=urllib.request.Request('http://" + api + ":8000/api/v1/work/' + sys.argv[1], headers={'Authorization':'Bearer '+Settings().auth_token.get_secret_value()}); d=json.load(urllib.request.urlopen(r,timeout=5)); print(json.dumps({'status':d['status'],'latency_s':time.monotonic()-t}))";
  const output = await run(`${owner}-status`, ['python', '-I', '-c', program, workId]);
  const value = JSON.parse(output);
  if (value.status !== 'running' || value.latency_s >= 5) throw new Error('Status query did not remain available during work');
  return value;
}

try {
  await build();
  imageBuilt = true;
  fixture = await createDatabaseFixture(owner);
  const admitted = await probe('bootstrap');
  await run(api, ['uvicorn', 'sabre.api:app', '--host', '0.0.0.0', '--port', '8000', '--no-access-log'], true);
  await until(async () => {
    try {
      await docker(['exec', api, 'python', '-I', '-c', "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=2)"], false, true);
      return true;
    } catch { return false; }
  }, 30000);
  await run(worker, ['/app/.venv/bin/python', '-m', 'integration.worker_probe', 'worker'], true);
  await until(async () => (await probe('state')).starts === 1, 30000);
  const before = await queryStatus(admitted.work_id);
  await docker(['kill', '--signal', 'KILL', worker]);
  const killed = await docker(['wait', worker]);
  if (killed !== '137') throw new Error('The fixture worker was not killed during active work');
  await run(control, ['/app/.venv/bin/python', '-m', 'integration.worker_probe', 'control'], true);
  await docker(['start', worker]);
  console.log('Isolated test worker terminated with SIGKILL; waiting for heartbeat detection and periodic recovery.');
  await until(async () => (await probe('state')).starts === 2, 100000);
  const resumed = await queryStatus(admitted.work_id);
  await probe('release');
  await until(async () => (await probe('state')).job_status === 'succeeded', 30000);
  const result = await probe('state');
  if (result.starts !== 2 || result.completions !== 1 || result.events !== 1 || result.work_status !== 'completed') {
    throw new Error('Recovery duplicated work or did not reach a durable completion');
  }
  console.log(JSON.stringify({ worker_exit: Number(killed), starts: result.starts, completions: result.completions,
    completion_events: result.events, queue_status: result.job_status, work_status: result.work_status,
    status_before_s: before.latency_s, status_resumed_s: resumed.latency_s }));
} catch (error) {
  for (const name of containers) {
    const details = await docker(['logs', '--tail', '25', name], true).catch(() => 'No logs available.');
    console.error(`${name}:\n${details}`);
  }
  throw error;
} finally {
  const cleanup = [];
  for (const name of containers.reverse()) cleanup.push(['rm', '-f', name]);
  if (imageBuilt) cleanup.push(['image', 'rm', tag]);
  const failures = [];
  for (const args of cleanup) {
    try { await docker(args); }
    catch { failures.push(args.at(-1)); }
  }
  if (fixture) await fixture.cleanup();
  if (failures.length) throw new Error(`Cleanup left owned resources pending: ${failures.join(', ')}`);
}
