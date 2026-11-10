import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { docker, ownedVolume, root, safeEnvironment, executable, prefix } from './bootstrap.mjs';
import { provisionClaude, provisionClaudeBridge } from './claude-bootstrap.mjs';

const owner = `sabre-factory-claude-check-${process.pid}-${randomBytes(4).toString('hex')}`;
const names = { bridge: `${owner}-bridge`, home: `${owner}-home` };
const python = 'python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527';
const inspect = "import hashlib,pathlib,stat,json; p=pathlib.Path('/bridge/token'); s=p.stat(); h=pathlib.Path('/home').stat(); print(json.dumps({'digest':hashlib.sha256(p.read_bytes()).hexdigest(),'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode),'home_uid':h.st_uid,'home_mode':stat.S_IMODE(h.st_mode)}))";
const container = `${owner}-probe`;
const inputContainer = `${owner}-input`;
let compose;
let inputCreated = false;
const created = new Set();
async function run(program, writable = false) {
  return docker(['run', '--rm', '--network', 'none', '--read-only', '--memory', '64m', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--mount', `type=volume,source=${names.bridge},target=/bridge,volume-nocopy${writable ? '' : ',readonly'}`,
    '--mount', `type=volume,source=${names.home},target=/home,volume-nocopy,readonly`, python, 'python', '-I', '-c', program]);
}
async function sendOwnerInput() {
  const child = spawn(executable, [...prefix, 'start', '--attach', '--interactive', inputContainer], {
    cwd: root, windowsHide: true, env: safeEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  let text = '';
  let sent = false;
  // Match an operator: send input after the container has displayed its prompt, not with the YAML.
  const timer = setTimeout(() => child.stdin.end(), 15000);
  const receive = (part) => {
    text += part.toString();
    if (!sent && text.includes('CLAUDE_OWNER_STDIN_READY')) {
      sent = true; child.stdin.write('synthetic-owner-input\n');
    }
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  child.stdin.on('error', () => {});
  try {
    await new Promise((ok, fail) => {
      child.once('error', () => fail(new Error('The synthetic input attachment could not start')));
      child.once('close', (code) => code === 0 ? ok() : fail(new Error('The synthetic input attachment failed')));
    });
  } finally { clearTimeout(timer); child.stdin.end(); }
  return text;
}
try {
  const existing = (await docker(['volume', 'ls', '--filter', `name=${owner}`, '--format', '{{.Name}}'])).toString().trim();
  if (existing) throw new Error('Refusing to reuse an existing Claude fixture');
  await provisionClaudeBridge(names); created.add('bridge');
  const firstVolumes = (await docker(['volume', 'ls', '--filter', `name=${owner}`, '--format', '{{.Name}}'])).toString().trim().split('\n');
  if (firstVolumes.includes(names.home)) throw new Error('Bridge-only provisioning created a session home');
  await provisionClaude(names); created.add('home');
  const before = JSON.parse((await run(inspect)).toString());
  await provisionClaude(names);
  const after = JSON.parse((await run(inspect)).toString());
  if (JSON.stringify(before) !== JSON.stringify(after) || before.uid !== 10001 || before.mode !== 0o400
      || before.home_uid !== 10001 || before.home_mode !== 0o700) throw new Error('Claude provisioning rotated an identity or weakened file permissions');

  const environment = safeEnvironment({ SABRE_MCP_SERVERS: '{}', SABRE_ROLE_MODELS: '{}', SABRE_ALLOWED_ORIGINS: '[]', SABRE_CODEX_SECCOMP_FILE: '/unused-codex-policy.json' });
  const configuration = JSON.parse((await docker(['compose', '-f', '-', '--profile', 'claude', 'config', '--format', 'json'],
    readFileSync(resolve(root, 'infra/compose.yml')), environment)).toString());
  const service = configuration.services['claude-runner'];
  if (!service || Object.keys(service.environment).some((key) => !['HOME', 'CLAUDE_CONFIG_DIR', 'SABRE_CLAUDE_CLI_HOME', 'SABRE_CLAUDE_CLI_TOKEN_FILE'].includes(key))) throw new Error('Claude service exposes an unexpected environment field');
  const probe = { ...service, image: python, container_name: container, profiles: undefined,
    healthcheck: { disable: true }, restart: 'no', labels: { 'sabre.owner': 'factory', 'sabre.kind': 'claude-profile-check' },
    command: ['python', '-I', '-c', "import os,pathlib; assert os.getuid()==10001; assert pathlib.Path('/run/secrets/claude-bridge/token').is_file(); assert not pathlib.Path('/var/run/docker.sock').exists(); print('CLAUDE_PROFILE_OK')"] };
  const document = JSON.stringify({ services: { probe }, networks: { claude_control: { internal: true }, claude_outbound: {} },
    volumes: { 'claude-home': { external: true, name: names.home }, 'claude-bridge': { external: true, name: names.bridge } } });
  compose = (args) => docker(['compose', '--project-name', owner, '-f', '-', ...args], document);
  await compose(['create', 'probe']);
  const [row] = JSON.parse((await docker(['inspect', container])).toString());
  const mounts = row.Mounts.filter((mount) => mount.Type !== 'tmpfs');
  if (row.Config.User !== '10001:10001' || !row.HostConfig.ReadonlyRootfs || row.HostConfig.Privileged
      || !row.HostConfig.CapDrop?.includes('ALL') || (row.HostConfig.CapAdd?.length ?? 0) !== 0
      || !row.HostConfig.SecurityOpt?.includes('no-new-privileges:true') || row.HostConfig.SecurityOpt.some((value) => value.startsWith('seccomp='))
      || Object.keys(row.HostConfig.PortBindings || {}).length || mounts.length !== 2
      || !mounts.some((mount) => mount.Name === names.home && mount.Destination === '/var/lib/sabre-claude' && mount.RW)
      || !mounts.some((mount) => mount.Name === names.bridge && mount.Destination === '/run/secrets/claude-bridge' && !mount.RW)
      || Object.keys(row.NetworkSettings.Networks).sort().join('|') !== [`${owner}_claude_control`, `${owner}_claude_outbound`].join('|')) {
    throw new Error('The effective Claude container crossed its trust boundary');
  }
  await compose(['start', 'probe']);
  const exit = (await docker(['wait', container])).toString().trim();
  if (exit !== '0' || !(await docker(['logs', container])).toString().includes('CLAUDE_PROFILE_OK')) throw new Error('The isolated Claude profile could not run');

  const inputProbe = { ...probe, container_name: inputContainer, stdin_open: true, tty: true,
    command: ['python', '-I', '-c', "import sys; print('CLAUDE_OWNER_STDIN_READY',flush=True); assert sys.stdin.readline().strip()=='synthetic-owner-input'; print('CLAUDE_OWNER_STDIN_OK')"] };
  const inputDocument = JSON.stringify({ services: { input: inputProbe }, networks: { claude_control: { internal: true }, claude_outbound: {} },
    volumes: { 'claude-home': { external: true, name: names.home }, 'claude-bridge': { external: true, name: names.bridge } } });
  await docker(['compose', '--project-name', owner, '-f', '-', 'create', 'input'], inputDocument); inputCreated = true;
  // YAML went to the creation command; a separate attach receives only terminal input.
  const attached = await sendOwnerInput();
  const inputExit = (await docker(['wait', inputContainer])).toString().trim();
  if (!attached.includes('CLAUDE_OWNER_STDIN_OK') || inputExit !== '0') {
    // This fixture contains only fixed synthetic input and no authentication state.
    const logs = (await docker(['logs', inputContainer], undefined, undefined, true)).toString();
    throw new Error('Synthetic owner input check failed: ' + JSON.stringify({ inputExit, attached, logs }));
  }

  await run("import os; os.chmod('/bridge/token',0o600)", true);
  let rejected = false;
  try { await provisionClaude(names); } catch { rejected = true; }
  const invalid = JSON.parse((await run(inspect)).toString());
  if (!rejected || invalid.digest !== before.digest || invalid.mode !== 0o600) throw new Error('Claude provisioning overwrote invalid existing material');
  console.log('Claude bootstrap and Compose boundary verified: private, repeatable, no overwrite, no account or inference.');
} finally {
  if (inputCreated) {
    const [row] = JSON.parse((await docker(['inspect', inputContainer])).toString());
    if (row.State.Running || row.Config.Labels?.['sabre.kind'] !== 'claude-profile-check' || row.Config.Labels?.['com.docker.compose.project'] !== owner) throw new Error('The input fixture cannot be safely removed');
    await docker(['rm', inputContainer]);
  }
  if (compose) await compose(['down']);
  for (const kind of created) {
    await ownedVolume(names[kind], `claude-${kind}`);
    await docker(['volume', 'rm', names[kind]]);
  }
}
