import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { safeEnvironment, createDatabaseFixture, controlEnvironment, docker as privateDocker } from './bootstrap.mjs';
import { withCodexBuildImages, withCliBuildImages, prepareCodexPolicy, codexSeccompClientPath } from './codex-bootstrap.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
import { executable as dockerCommand, prefix as dockerPrefix } from './platform.mjs';
const tarCommand = windows ? 'tar.exe' : 'tar';

function start(command, args, stdio = 'inherit') {
  return spawn(command, args, { cwd: root, windowsHide: true, env: safeEnvironment(), stdio });
}
function done(child) {
  return new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveDone() : reject(new Error(`Process failed (${code})`)));
  });
}
async function docker(args) {
  await done(start(dockerCommand, [...dockerPrefix, ...args]));
}
async function build(target = 'dev', recipe = 'infra/Dockerfile.backend', extraArgs = []) {
  const tag = `sabre-factory-${target}-${process.pid}:local`;
  const archive = start(tarCommand, [
    '--exclude=.git', '--exclude=work', '--exclude=.env', '--exclude=.env.*', '--exclude=.sabre',
    '--exclude=node_modules', '--exclude=.venv', '--exclude=__pycache__',
    '--exclude=dist', '--exclude=.pytest_cache', '--exclude=.ruff_cache',
    '--exclude=test-results*', '--exclude=playwright-report',
    '-cf', '-', '.',
  ], ['ignore', 'pipe', 'inherit']);
  const image = start(dockerCommand, [...dockerPrefix, 'build', '--progress=plain',
    ...(recipe === 'infra/Dockerfile.backend' ? ['--target', target] : []), '-f', recipe, '-t', tag,
    '-t', `sabre-factory-${target}:local`, ...extraArgs, '-'],
  ['pipe', 'inherit', 'inherit']);
  archive.stdout.pipe(image.stdin);
  await Promise.all([done(archive), done(image)]);
  return tag;
}

const [action = 'test', ...extra] = process.argv.slice(2);
const commands = {
  lock: ['uv', 'lock', '--exclude-newer', '2026-10-29T00:00:00Z'],
  test: ['uv', 'run', '--no-sync', 'pytest', ...extra],
  lint: ['uv', 'run', '--no-sync', 'ruff', 'check', ...extra],
  types: ['uv', 'run', '--no-sync', 'mypy', 'src/sabre', ...extra],
  'codex-policy': ['uv', 'run', '--no-sync', 'pytest', '-p', 'no:cacheprovider', '--basetemp=/tmp/sabre-codex-policy', 'native_checks/test_codex_policy.py', ...extra],
  'claude-policy': ['uv', 'run', '--no-sync', 'pytest', '-p', 'no:cacheprovider', '--basetemp=/tmp/sabre-claude-policy', 'native_checks/test_claude_policy.py', ...extra],
  run: extra,
};
if (!commands[action]?.length) throw new Error('Use lock, test, lint, types, codex-policy, claude-policy, or run <argv...>');
const nativePolicy = ['codex-policy', 'claude-policy'].includes(action);
const apparmorProfile = process.env.SABRE_CODEX_APPARMOR_PROFILE;
if (apparmorProfile && (action !== 'codex-policy' || process.platform !== 'linux'
    || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || !/^sabre-codex-ci-[0-9]+-[0-9]+-[A-Za-z0-9]{8}$/.test(apparmorProfile))) {
  throw new Error('Only an approved per-job AppArmor profile may be selected for native CI');
}
let seccompPath;
if (action === 'codex-policy') {
  await docker(['version', '--format', 'Docker client={{.Client.Version}} server={{.Server.Version}}']);
  await docker(['info', '--format', 'Docker SecurityOptions={{json .SecurityOptions}}']);
  await prepareCodexPolicy();
  seccompPath = await codexSeccompClientPath();
}
const baseTag = await build(action === 'lock' ? 'lock' : 'dev');
let imageTag = baseTag;
const name = `sabre-factory-dev-${process.pid}`;
const runKey = randomBytes(12).toString('hex');
const network = action === 'lock' ? 'bridge' : nativePolicy ? 'none' : process.env.SABRE_DEV_NETWORK ?? 'none';
if (!['none', 'bridge'].includes(network) && !/^sabre-factory_[a-z]+$/.test(network)) {
  throw new Error('Development checks may only use a SABRE network');
}
let started = false;
let fixture;
let executionError;
try {
  if (action === 'codex-policy') {
    imageTag = await withCodexBuildImages(baseTag, (args) => build('codex-policy', 'infra/Dockerfile.codex-runner', args));
  }
  if (action === 'claude-policy') {
    imageTag = await withCliBuildImages('claude', baseTag, (args) => build('claude-policy', 'infra/Dockerfile.claude-runner', args));
  }
  if (network === 'sabre-factory_control') fixture = await createDatabaseFixture(`sabre-factory-dev-pg-${process.pid}`);
  started = true;
  const selected = commands[action];
  if (selected[0] === 'uv' && selected[1] === 'run' && !selected.includes('--no-sync')) {
    selected.splice(2, 0, '--no-sync');
  }
  const environment = [];
  if (apparmorProfile) environment.push('--security-opt', `apparmor=${apparmorProfile}`,
    '--label', `sabre.apparmor_profile=${apparmorProfile}`, '-e', `SABRE_EXPECT_APPARMOR_PROFILE=${apparmorProfile}`);
  if (fixture) environment.push('-v', `${fixture.bootstrap}:/run/secrets/sabre:ro`, ...controlEnvironment);
  await docker(['run', '--name', name, '--memory', '2g', '--cpus', '2', '--network', fixture?.network ?? network,
    '--label', 'sabre.owner=factory', '--label', 'sabre.kind=development-check', '--label', `sabre.run=${runKey}`,
    ...(nativePolicy ? ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '128',
      ...(action === 'codex-policy' ? ['--security-opt', `seccomp=${seccompPath}`] : []),
      '--tmpfs', '/tmp:rw,size=128m,mode=1777', '-e', 'UV_CACHE_DIR=/tmp/uv-cache'] : ['-v', 'sabre-factory-uv-cache:/root/.cache/uv']),
    '-e', 'PYTHONPATH=/app',
    '-e', 'UV_EXCLUDE_NEWER=2026-10-29T00:00:00Z',
    ...environment, imageTag, ...selected]);
  if (action === 'lock') {
    const copy = start(dockerCommand, [...dockerPrefix, 'cp', `${name}:/app/uv.lock`, '-'],
      ['ignore', 'pipe', 'inherit']);
    const extract = start(tarCommand, ['-xf', '-', '-C', 'backend', 'uv.lock'],
      ['pipe', 'inherit', 'inherit']);
    copy.stdout.pipe(extract.stdin);
    await Promise.all([done(copy), done(extract)]);
  }
} catch (error) {
  executionError = error;
} finally {
  const errors = executionError ? [executionError] : [];
  const cleanup = async (operation) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  if (started) await cleanup(async () => {
    const existing = (await privateDocker(['ps', '-aq', '--filter', `name=^/${name}$`,
      '--filter', 'label=sabre.owner=factory', '--filter', `label=sabre.run=${runKey}`])).toString().trim();
    if (existing) await docker(['rm', name]);
  });
  if (fixture) await cleanup(() => fixture.cleanup());
  await cleanup(() => docker(['image', 'rm', imageTag]));
  if (baseTag !== imageTag) await cleanup(() => docker(['image', 'rm', baseTag]));
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Development checks and cleanup failed');
}
