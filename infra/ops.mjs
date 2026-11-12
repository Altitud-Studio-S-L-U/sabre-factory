import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { safeEnvironment, provisionBootstrap, rawSecretNames, readPrivate, privateJson, volumes as bootstrapVolumes,
  docker as privateDocker, controlEnvironment } from './bootstrap.mjs';
import { provisionCodex, withCodexBuildImages, withCliBuildImages, prepareCodexPolicy, codexSeccompClientPath } from './codex-bootstrap.mjs';
import { provisionClaude, provisionClaudeBridge } from './claude-bootstrap.mjs';
import { provisionExecutorState } from './executor-state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const windows = process.platform === 'win32';
import { executable, prefix } from './platform.mjs';
const cliArguments = process.argv.slice(2);
const noOpen = cliArguments.includes('--no-open');
const [action = 'status', component = 'all', ...rest] = cliArguments.filter((value) => value !== '--no-open');
const invoked = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
const configFiles = invoked ? ['.env', '.env.runtime'] : [];
const config = {};
for (const file of configFiles) {
  if (!existsSync(resolve(root, file))) continue;
  for (const line of readFileSync(resolve(root, file), 'utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Unsupported environment line in ${file}`);
    if (!/^(SABRE_|OPENAI_API_KEY$|SLACK_)/.test(match[1])) throw new Error('Unexpected configuration key');
    config[match[1]] = match[2];
  }
}
const env = safeEnvironment(config);

function start(command, args, stdio = 'inherit', environment = env) {
  return spawn(command, args, { cwd: root, windowsHide: true, env: environment, stdio });
}
function done(child) {
  return new Promise((resolveDone, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolveDone() : reject(new Error(`Process failed (${code})`)));
  });
}
async function docker(args, capture = false) {
  const child = start(executable, [...prefix, ...args], capture ? ['ignore', 'pipe', 'inherit'] : 'inherit');
  const chunks = [];
  if (capture) child.stdout.on('data', (chunk) => chunks.push(chunk));
  await done(child);
  return capture ? Buffer.concat(chunks).toString('utf8').trim() : '';
}
async function build(file, tag, buildArgs = []) {
  let previous;
  try { previous = await docker(['image', 'inspect', tag, '--format', '{{.Id}}'], true); }
  catch { /* A first installation has no previous image. */ }
  if (previous) {
    if (!/^sha256:[a-f0-9]{64}$/.test(previous)) throw new Error('Invalid previous image digest');
    // Backups reference exact images. Retagging must not orphan their manifests.
    await docker(['tag', previous, `sabre-factory-retained:${previous.slice(7)}`]);
  }
  const archive = start(windows ? 'tar.exe' : 'tar', [
    '--exclude=.git', '--exclude=work', '--exclude=.env', '--exclude=.env.*', '--exclude=.sabre',
    '--exclude=node_modules', '--exclude=.venv', '--exclude=__pycache__',
    '--exclude=dist', '--exclude=.pytest_cache', '--exclude=.ruff_cache', '-cf', '-', '.',
  ], ['ignore', 'pipe', 'inherit']);
  const builder = start(executable, [...prefix, 'build', '--progress=plain', '-f', file, '-t', tag, ...buildArgs, '-'],
    ['pipe', 'inherit', 'inherit']);
  archive.stdout.pipe(builder.stdin);
  await Promise.all([done(archive), done(builder)]);
}
async function compose(args, document, capture = false) {
  const creates = args.some((arg) => ['up', 'run', 'create'].includes(arg));
  let profilePath = '/sabre-codex-policy-not-prepared.json';
  if (creates && document === undefined) await prepareCodexPolicy();
  try { profilePath = await codexSeccompClientPath(); }
  catch (error) { if (creates && document === undefined) throw error; }
  const composeEnvironment = safeEnvironment({ ...config, SABRE_CODEX_SECCOMP_FILE: profilePath });
  const child = start(executable, [...prefix, 'compose', '--project-name', 'sabre-factory', '-f', '-', ...args],
    ['pipe', capture ? 'pipe' : 'inherit', 'inherit'], composeEnvironment);
  const chunks = [];
  if (capture) child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stdin.end(document ?? readFileSync(resolve(root, 'infra/compose.yml')));
  await done(child);
  return capture ? Buffer.concat(chunks).toString('utf8') : '';
}

export async function prepareScannerImages(document, pull) {
  const environment = document?.services?.executor?.environment;
  const images = ['SABRE_GITLEAKS_IMAGE', 'SABRE_SEMGREP_IMAGE', 'SABRE_TRIVY_IMAGE'].map((key) => environment?.[key]);
  if (images.some((image) => typeof image !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(image))) {
    throw new Error('All security scanner images must be immutable digest-pinned references');
  }
  for (const image of images) await pull(image);
}
function rulesDigest() {
  const sum = createHash('sha256');
  for (const name of ['gitleaks.toml', 'rules.yml', 'trivy.yaml', 'emptyignore']) {
    sum.update(name + '\0'); sum.update(readFileSync(resolve(root, 'infra/rules', name)));
  }
  return sum.digest('hex');
}
async function prepareRules() {
  const expected = rulesDigest();
  const volume = `sabre-factory-rules-${expected.slice(0, 20)}`;
  await docker(['volume', 'create', '--label', 'sabre.owner=factory', '--label', 'sabre.kind=rules', volume]);
  const program = "import hashlib,pathlib; h=hashlib.sha256(); [(h.update(n.encode()+b'\\x00'),h.update((pathlib.Path('/rules')/n).read_bytes())) for n in ['gitleaks.toml','rules.yml','trivy.yaml','emptyignore']]; print(h.hexdigest())";
  const actual = await docker(['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'python',
    '-v', `${volume}:/rules:ro`, 'sabre-factory-api:local', '-I', '-c', program], true);
  if (actual !== expected) throw new Error('Trusted rules differ from the application image; rebuild api before preparing rules');
  return volume;
}

function panelFailure(code, message) {
  return Object.assign(new Error(message), { code });
}

function enableClaudeProfile() {
  if (Object.keys(config).some((key) => rawSecretNames.has(key))) throw new Error('Migrate legacy credentials before preparing a CLI session');
  const target = resolve(root, '.env');
  if (!existsSync(target)) throw new Error('Initialize SABRE before preparing Claude');
  const original = readFileSync(target, 'utf8');
  const lines = original.split(/\r?\n/).filter((line) => !line.startsWith('SABRE_CLAUDE_ENABLED='));
  while (lines.at(-1) === '') lines.pop();
  const temporary = resolve(root, `.env.claude-next-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, [...lines, 'SABRE_CLAUDE_ENABLED=true', ''].join('\n'), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  config.SABRE_CLAUDE_ENABLED = 'true';
}

export function requireClaudeOwnerTerminal(input = process.stdin, output = process.stdout) {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw panelFailure('CLAUDE_OWNER_TERMINAL_REQUIRED', 'Run claude-login in your own interactive terminal without capturing or redirecting output.');
  }
}

export async function runClaudeOwnerLogin({ input = process.stdin, output = process.stdout, create, attach, remove }) {
  requireClaudeOwnerTerminal(input, output);
  let created = false;
  try {
    await create(); created = true;
    requireClaudeOwnerTerminal(input, output);
    await attach();
  } finally {
    if (created) await remove();
  }
}

/** Browser opener per platform. It only ever receives the one-use local relay address, never the grant. */
export function browserOpener(platform = process.platform) {
  if (platform === 'win32') return { command: 'explorer.exe', exitCodeReliable: false };
  if (platform === 'darwin') return { command: 'open', exitCodeReliable: true };
  return { command: 'xdg-open', exitCodeReliable: true };
}

/**
 * One-use loopback relay: the browser fetches an unguessable local path and is redirected to the panel
 * with the grant in the URL fragment. The grant never appears in process arguments, terminal output or logs.
 */
export async function serveHandoff(target, { timeoutMs = 60_000, createServer } = {}) {
  const create = createServer ?? (await import('node:http')).createServer;
  const path = `/${randomBytes(32).toString('base64url')}`;
  let settle;
  const delivered = new Promise((resolveDelivered) => { settle = resolveDelivered; });
  const server = create((request, response) => {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
    if (request.method !== 'GET' || request.url !== path) {
      response.writeHead(404, headers).end();
      return;
    }
    response.writeHead(303, { ...headers, Location: target }).end();
    close(true);
  });
  const timer = setTimeout(() => close(false), timeoutMs);
  function close(value) {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    settle(value);
  }
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  return { address: `http://127.0.0.1:${server.address().port}${path}`, delivered, close: () => close(false) };
}

export async function openPanelAccess({ output = process.stdout, requestGrant, launchBrowser,
  handoff = serveHandoff }) {
  let receipt;
  try { receipt = await requestGrant(); }
  catch { throw panelFailure('PANEL_UNAVAILABLE', 'Panel access could not be prepared. Check that SABRE is running.'); }
  let origin;
  try { origin = new URL(receipt?.origin); } catch { /* Reject invalid grants without reporting their contents. */ }
  if (!origin || typeof receipt.origin !== 'string' || typeof receipt.ticket !== 'string' || receipt.expires_in !== 60
      || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$/.test(receipt.origin)
      || !['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
      || !/^[A-Za-z0-9_-]{43}$/.test(receipt.ticket)) {
    throw panelFailure('PANEL_GRANT_INVALID', 'SABRE returned an invalid temporary access grant.');
  }
  const url = `${receipt.origin}/#ticket=${encodeURIComponent(receipt.ticket)}`;
  let relay;
  try { relay = await handoff(url); }
  catch { throw panelFailure('PANEL_LAUNCH_FAILED', 'The local browser relay could not start. Run sabre open again.'); }
  try { await launchBrowser(relay.address); }
  catch {
    relay.close();
    throw panelFailure('PANEL_LAUNCH_FAILED', 'The browser could not open. Run sabre open again from your desktop session.');
  }
  if (!(await relay.delivered)) {
    throw panelFailure('PANEL_LAUNCH_FAILED', 'The browser did not open SABRE within 60 seconds. Run sabre open again.');
  }
  try { output.write(`Panel opened in your browser at ${receipt.origin}. It stays signed in while you use it.\n`); }
  catch { /* The browser already has its session; a closed terminal is not a failure. */ }
}

/** Starts the platform opener with only the local relay address. */
export async function launchWithOpener(address, { platform = process.platform, spawnProcess = spawn } = {}) {
  const opener = browserOpener(platform);
  const child = spawnProcess(opener.command, [address], { stdio: 'ignore', windowsHide: true, detached: platform !== 'win32' });
  await new Promise((ok, fail) => {
    child.once('error', fail);
    // explorer.exe reports 1 even after opening the default browser; delivery is confirmed by the relay.
    child.once('exit', (code) => (code === 0 || !opener.exitCodeReliable ? ok() : fail(new Error('Opener failed'))));
  });
  child.unref?.();
}

const grantProgram = String.raw`
import json,urllib.request
from sabre.settings import Settings
try:
 cfg=Settings()
 request=urllib.request.Request('http://127.0.0.1:8000/api/v1/panel/session-ticket',method='POST',headers={'Authorization':'Bearer '+cfg.auth_token.get_secret_value()})
 with urllib.request.urlopen(request,timeout=10) as response: result=json.load(response)
 print(json.dumps(result))
except Exception:
 print(json.dumps({'error':'PANEL_UNAVAILABLE'}))
`;

async function openPanel() {
  await openPanelAccess({
    // The grant is requested inside the API container with the owner credential, which never leaves it.
    requestGrant: async () => privateJson((await privateDocker(['exec', 'sabre-factory-api-1', 'python', '-I', '-c', grantProgram])).toString()),
    launchBrowser: (address) => launchWithOpener(address),
  });
}

if (invoked) {
if (action === 'init') {
  if (existsSync(resolve(root, '.env'))) throw new Error('Configuration already exists; use migrate-credentials');
  await provisionBootstrap();
  await provisionCodex();
  await provisionClaudeBridge();
  writeFileSync(resolve(root, '.env'), [
    'SABRE_PORT=8000', 'SABRE_MODEL_NAME=', 'SABRE_MODEL_PROVIDER=codex_cli',
    'SABRE_MODEL_BASE_URL=', 'SABRE_MONTHLY_BUDGET_USD=0', 'SABRE_MODEL_INPUT_USD_PER_MILLION=0',
    'SABRE_MODEL_OUTPUT_USD_PER_MILLION=0', 'SABRE_OTLP_ENDPOINT=',
    'SABRE_EMBEDDING_MODEL=', 'SABRE_EMBEDDING_USD_PER_MILLION=0', 'SABRE_CHAT_BUDGET_USD=0.25',
    'SABRE_MCP_SERVERS={}', 'SABRE_ROLE_MODELS={}',
    'SABRE_ALLOWED_ORIGINS=["http://localhost:8000","http://127.0.0.1:8000"]',
    'SABRE_SLACK_OWNER_ID=', 'SABRE_CLAUDE_ENABLED=false', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Local configuration created; external providers remain disabled.');
} else if (action === 'migrate-credentials') {
  const existing = new Set((await privateDocker(['ps', '-a', '--format', '{{.Names}}'])).toString().trim().split('\n'));
  for (const [container, mappings] of [['sabre-factory-postgres-1', { POSTGRES_PASSWORD: 'SABRE_DB_ADMIN_PASSWORD', SABRE_DB_PASSWORD: 'SABRE_DB_PASSWORD' }],
    ['sabre-factory-api-1', { SABRE_AUTH_TOKEN: 'SABRE_AUTH_TOKEN', SABRE_EXECUTOR_TOKEN: 'SABRE_EXECUTOR_TOKEN' }]]) {
    if (!existing.has(container)) continue;
    const current = privateJson((await privateDocker(['inspect', container])).toString())[0];
    if (current.Config.Labels?.['com.docker.compose.project'] !== 'sabre-factory') throw new Error('Migration refused a container owned by another project');
    const old = Object.fromEntries(current.Config.Env.map((item) => { const index = item.indexOf('='); return [item.slice(0, index), item.slice(index + 1)]; }));
    if (Object.entries(mappings).some(([key, target]) => old[key] && old[key] !== config[target])) {
      throw new Error('Running bootstrap credentials disagree with local configuration; no credentials were changed');
    }
  }
  const pg = 'sabre-factory-postgres-1';
  const countSql = "SELECT count(*),count(*) FILTER(WHERE data->>'status'='running'),count(*) FILTER(WHERE data->>'status'='waiting_input') FROM work_orders;";
  const countWork = () => privateDocker(['exec', '-i', pg, 'psql', '-U', 'sabre_admin', '-d', 'sabre', '-At', '-v', 'ON_ERROR_STOP=1'], countSql);
  const commands = (await privateDocker(['ps', '--filter', 'label=sabre.owner=factory', '--filter', 'label=sabre.kind=command', '--format', '{{.ID}}'])).toString().trim();
  const before = existing.has(pg) ? (await countWork()).toString().trim() : '';
  if (commands || (before && Number(before.split('|')[1]) !== 0)) throw new Error('Pause active work and wait for tool commands before migrating credentials');
  await provisionBootstrap({ legacy: config });
  // Stop trusted writers before replacing their startup contract; data volumes remain intact.
  await compose(['stop', 'api', 'worker', 'control', 'slack', 'executor']);
  await compose(['up', '-d', '--wait', '--wait-timeout', '90', 'postgres']);
  await privateDocker(['exec', 'sabre-factory-postgres-1', '/bin/sh', '/docker-entrypoint-initdb.d/20-app-user.sh']);
  const migrated = privateJson((await privateDocker(['run', '--rm', '-i', '--network', 'sabre-factory_control',
    '--read-only', '--memory', '256m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '-v', `${bootstrapVolumes.control}:/run/secrets/sabre:ro`, ...controlEnvironment,
    'sabre-factory-api:local', 'python', '/app/operations/import-legacy.py'], JSON.stringify(config))).toString());
  if (!migrated.public || Object.keys(migrated.public).some((key) => rawSecretNames.has(key))) throw new Error('Migration returned invalid public configuration');
  if (before && (await countWork()).toString().trim() !== before) throw new Error('Work state changed during migration; services remain stopped and the legacy configuration was retained');
  const target = resolve(root, '.env');
  const temporary = resolve(root, `.env.public-next-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temporary, Object.entries(migrated.public).filter(([key]) => !['SABRE_PYTHON_IMAGE', 'SABRE_NODE_IMAGE', 'SABRE_HELPER_IMAGE', 'SABRE_RULES_VOLUME'].includes(key))
      .map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, target);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  console.log(`Credentials migrated to the vault (${migrated.imported} targets); public configuration retained. Run up to start services.`);
} else if (action === 'access-token') {
  // Explicit terminal-only owner action. Do not call this through an agent, API or MCP tool.
  const privateConfig = privateJson((await readPrivate(bootstrapVolumes.control, 'control.json')).toString());
  console.log(privateConfig.auth_token);
} else if (action === 'open') {
  if (component !== 'all' || rest.length) throw new Error('Use open without arguments.');
  try { await openPanel(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else if (action === 'prepare-codex') {
  await provisionCodex();
  await prepareCodexPolicy();
  console.log('Private Codex storage and internal credential prepared; login has not run.');
} else if (action === 'prepare-claude') {
  await provisionClaude();
  enableClaudeProfile();
  console.log('Private Claude session and bridge prepared; the profile is enabled for future starts. Login and inference have not run.');
} else if (action === 'claude-login') {
  requireClaudeOwnerTerminal();
  if (component !== 'all' || rest.length) throw new Error('Use claude-login without arguments; it connects your Claude subscription.');
  const consumers = (await privateDocker(['ps', '--filter', 'label=com.docker.compose.project=sabre-factory',
    '--filter', 'label=com.docker.compose.service=claude-runner', '--format', '{{.ID}}'])).toString().trim();
  if (consumers) throw new Error('Stop the bridge with node bin/sabre.mjs stop claude-runner before changing the Claude account.');
  await provisionClaude();
  enableClaudeProfile();
  const name = 'sabre-factory-claude-owner-login';
  const listed = (await privateDocker(['ps', '-a', '--format', '{{.Names}}'])).toString().trim().split('\n');
  if (listed.includes(name)) throw new Error('A Claude owner login is already pending; inspect it before starting another.');
  const resolved = privateJson((await privateDocker(['compose', '--project-name', 'sabre-factory', '-f', '-', '--profile', 'claude', 'config', '--format', 'json'],
    readFileSync(resolve(root, 'infra/compose.yml')), safeEnvironment({ ...config, SABRE_CODEX_SECCOMP_FILE: '/unused-codex-policy.json' }))).toString());
  const image = (await privateDocker(['image', 'inspect', resolved.services['claude-runner'].image, '--format', '{{.Id}}'])).toString().trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('The pinned Claude image is missing');
  const login = { ...resolved.services['claude-runner'], image, profiles: undefined, container_name: name,
    restart: 'no', healthcheck: { disable: true }, stdin_open: true, tty: true,
    entrypoint: ['/opt/claude/bin/claude'], command: ['auth', 'login', '--claudeai'],
    labels: { 'sabre.owner': 'factory', 'sabre.kind': 'claude-owner-login' },
    networks: { claude_outbound: null }, volumes: resolved.services['claude-runner'].volumes.filter((volume) => volume.source === 'claude-home'),
    environment: { HOME: '/var/lib/sabre-claude', CLAUDE_CONFIG_DIR: '/var/lib/sabre-claude', DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1', CLAUDE_CODE_DISABLE_WORKFLOWS: '1' } };
  const document = JSON.stringify({ services: { 'claude-owner-login': login },
    volumes: { 'claude-home': resolved.volumes['claude-home'] }, networks: { claude_outbound: resolved.networks.claude_outbound } });
  let released = false;
  try {
    await runClaudeOwnerLogin({
      create: () => compose(['create', 'claude-owner-login'], document),
      // YAML creation has finished; this separate command inherits the owner's actual console streams.
      attach: () => done(start(executable, [...prefix, 'start', '--attach', '--interactive', name], 'inherit')),
      remove: async () => {
        const [row] = privateJson((await privateDocker(['inspect', name])).toString());
        if (row.State.Running || row.Config.Labels?.['sabre.owner'] !== 'factory' || row.Config.Labels?.['sabre.kind'] !== 'claude-owner-login') {
          throw new Error('Claude login is still active or its ownership cannot be verified; the bridge remains stopped.');
        }
        await privateDocker(['rm', name]); released = true;
      },
    });
  } finally {
    if (released) await compose(['--profile', 'claude', 'up', '-d', '--wait', '--wait-timeout', '90', 'claude-runner']);
  }
} else if (action === 'codex-login') {
  // Owner-terminal action: Codex performs device login in SABRE's private home; no credential file is read here.
  await provisionCodex();
  await compose(['stop', 'codex-runner']);
  try {
    await compose(['--profile', 'codex', 'run', '-T', '--interactive=false', '--rm', '--no-deps', '--entrypoint', '/opt/codex/bin/codex', 'codex-runner',
      'login', '-c', 'cli_auth_credentials_store="file"', '-c', 'forced_login_method="chatgpt"', '--device-auth']);
  } finally {
    await compose(['--profile', 'codex', 'up', '-d', '--wait', '--wait-timeout', '90', 'codex-runner']);
  }
} else if (action === 'build') {
  const targets = {
    postgres: ['infra/Dockerfile.postgres', 'sabre-factory-postgres:local'],
    python: ['infra/Dockerfile.python-runner', 'sabre-factory-python:local'],
    node: ['infra/Dockerfile.node-runner', 'sabre-factory-node:local'],
    browser: ['infra/Dockerfile.browser-runner', 'sabre-factory-browser:local'],
    proxy: ['infra/Dockerfile.proxy', 'sabre-factory-proxy:local'],
    'security-proxy': ['infra/Dockerfile.security-proxy', 'sabre-factory-security-proxy:local'],
    api: ['infra/Dockerfile.backend', 'sabre-factory-api:local'],
    'codex-runner': ['infra/Dockerfile.codex-runner', 'sabre-factory-codex-runner:local'],
    'claude-runner': ['infra/Dockerfile.claude-runner', 'sabre-factory-claude-runner:local'],
  };
  if (component !== 'all' && !(component in targets)) throw new Error('Unknown build target');
  for (const [name, [file, tag]] of Object.entries(targets)) {
    if (component !== 'all' && component !== name) continue;
    if (name === 'codex-runner') {
      await withCodexBuildImages('sabre-factory-api:local', (args) => build(file, tag, args));
    } else if (name === 'claude-runner') {
      await withCliBuildImages('claude', 'sabre-factory-api:local', (args) => build(file, tag, args));
    } else await build(file, tag);
  }
  const runtime = {};
  for (const [key, tag] of [['SABRE_PYTHON_IMAGE', 'sabre-factory-python:local'],
    ['SABRE_NODE_IMAGE', 'sabre-factory-node:local'], ['SABRE_HELPER_IMAGE', 'sabre-factory-python:local']]) {
    try { runtime[key] = await docker(['image', 'inspect', tag, '--format', '{{.Id}}'], true); }
    catch { if (component === 'all') throw new Error(`Missing runtime image ${tag}`); }
  }
  if (Object.keys(runtime).length === 3) {
    try {
      const runner = await docker(['image', 'inspect', 'sabre-factory-codex-runner:local', '--format', '{{.Id}}'], true);
      if (!/^sha256:[a-f0-9]{64}$/.test(runner)) throw new Error('Invalid Codex runner image digest');
      runtime.SABRE_CODEX_RUNNER_IMAGE = runner;
    } catch { if (component === 'all' || component === 'codex-runner') throw new Error('Missing pinned Codex runner image'); }
    try {
      const runner = await docker(['image', 'inspect', 'sabre-factory-claude-runner:local', '--format', '{{.Id}}'], true);
      if (!/^sha256:[a-f0-9]{64}$/.test(runner)) throw new Error('Invalid Claude runner image digest');
      runtime.SABRE_CLAUDE_RUNNER_IMAGE = runner;
    } catch { if (component === 'all' || component === 'claude-runner') throw new Error('Missing pinned Claude runner image'); }
    try {
      const browser = await docker(['image', 'inspect', 'sabre-factory-browser:local', '--format', '{{.Id}}'], true);
      if (!/^sha256:[a-f0-9]{64}$/.test(browser)) throw new Error('Invalid browser image digest');
      runtime.SABRE_BROWSER_IMAGE = browser;
    } catch { if (component === 'all' || component === 'browser') throw new Error('Missing pinned browser image'); }
    runtime.SABRE_RULES_VOLUME = `sabre-factory-rules-${rulesDigest().slice(0, 20)}`;
    if (component === 'api' || component === 'all') {
      runtime.SABRE_RULES_VOLUME = await prepareRules();
    }
    writeFileSync(resolve(root, '.env.runtime'), Object.entries(runtime).map(([k, v]) => `${k}=${v}\n`).join(''),
      { mode: 0o600 });
  }
} else if (action === 'config') {
  await compose(['config', '--quiet']);
} else if (action === 'up') {
  if (Object.keys(config).some((key) => rawSecretNames.has(key))) throw new Error('Run migrate-credentials before starting the updated services');
  if (['all', 'executor', 'worker', 'control'].includes(component)) await provisionExecutorState();
  if (['all', 'api', 'worker', 'control'].includes(component)) await provisionClaudeBridge();
  const usesCodex = config.SABRE_MODEL_PROVIDER === 'codex_cli'
    || Object.values(privateJson(config.SABRE_ROLE_MODELS || '{}')).some((role) => role.model_provider === 'codex_cli');
  const usesClaude = config.SABRE_CLAUDE_ENABLED === 'true' || component === 'claude-runner' || config.SABRE_MODEL_PROVIDER === 'claude_cli'
    || Object.values(privateJson(config.SABRE_ROLE_MODELS || '{}')).some((role) => role.model_provider === 'claude_cli');
  if (usesClaude) await provisionClaude();
  await compose([...(usesCodex ? ['--profile', 'codex'] : []), ...(usesClaude ? ['--profile', 'claude'] : []),
    'up', '-d', '--wait', '--wait-timeout', '90', ...(component === 'all' ? [] : [component]), ...rest]);
  if (component === 'all' && !rest.length && !noOpen && !process.env.CI) {
    // Opening the panel is a convenience: services are already running if it fails.
    try { await openPanel(); }
    catch (error) { console.error(`${error.message} Services are running; open the panel later with sabre open.`); }
  }
} else if (action === 'prepare') {
  const volume = await prepareRules();
  const rendered = JSON.parse(await compose(['config', '--format', 'json'], undefined, true));
  await prepareScannerImages(rendered, (image) => docker(['pull', image]));
  const runtime = Object.fromEntries(['SABRE_PYTHON_IMAGE', 'SABRE_NODE_IMAGE', 'SABRE_HELPER_IMAGE']
    .map((key) => [key, config[key]]));
  if (Object.values(runtime).some((value) => !value)) throw new Error('Build python and node before preparing security');
  runtime.SABRE_RULES_VOLUME = volume;
  if (config.SABRE_BROWSER_IMAGE) runtime.SABRE_BROWSER_IMAGE = config.SABRE_BROWSER_IMAGE;
  if (config.SABRE_CODEX_RUNNER_IMAGE) runtime.SABRE_CODEX_RUNNER_IMAGE = config.SABRE_CODEX_RUNNER_IMAGE;
  if (config.SABRE_CLAUDE_RUNNER_IMAGE) runtime.SABRE_CLAUDE_RUNNER_IMAGE = config.SABRE_CLAUDE_RUNNER_IMAGE;
  writeFileSync(resolve(root, '.env.runtime'), Object.entries(runtime).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
  await compose(['--profile', 'prepare', 'run', '--rm', 'trivy-db']);
} else if (action === 'slack') {
  await compose(['--profile', 'slack', 'up', '-d', 'slack']);
} else if (action === 'telemetry') {
  await compose(['--profile', 'telemetry', 'up', '-d', 'jaeger']);
} else if (action === 'stop' && component === 'claude-runner' && rest.length === 0) {
  await compose(['--profile', 'claude', 'stop', 'claude-runner']);
} else if (action === 'down') {
  await compose(['--profile', 'slack', '--profile', 'telemetry', '--profile', 'codex', '--profile', 'claude', 'down']);
} else if (action === 'logs') {
  if (rest.length) throw new Error('Use logs with an optional service name.');
  await compose(['logs', '--tail', '200', ...(component === 'all' ? [] : [component])]);
} else if (action === 'status') {
  await compose(['ps', '--all']);
} else {
  throw new Error('Use init, migrate-credentials, open, access-token, prepare-codex, prepare-claude, codex-login, claude-login, stop claude-runner, build [target], config, up [service], prepare, slack, telemetry, status or down');
}
}
