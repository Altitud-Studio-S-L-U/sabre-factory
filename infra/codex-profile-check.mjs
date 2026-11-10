import { randomBytes } from 'node:crypto';
import { docker } from './bootstrap.mjs';
import { codexSeccompClientPath, prepareCodexPolicy, verifyCodexSeccomp } from './codex-bootstrap.mjs';

await prepareCodexPolicy();
const profilePath = await codexSeccompClientPath();
const project = `sabre-factory-profile-${process.pid}-${randomBytes(4).toString('hex')}`;
const name = `${project}-probe`;
const yaml = `services:
  probe:
    image: python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527
    container_name: ${name}
    user: '10001:10001'
    network_mode: none
    read_only: true
    cap_drop: [ALL]
    pids_limit: 32
    mem_limit: 64m
    labels: {sabre.owner: factory, sabre.kind: codex-profile-check}
    security_opt:
      - no-new-privileges:true
      - ${JSON.stringify(`seccomp=${profilePath}`)}
    command: [python, -I, -c, "print('synthetic compose check')"]
`;
const compose = (args) => docker(['compose', '--project-name', project, '-f', '-', ...args], Buffer.from(yaml));
let created = false;
try {
  await compose(['create', 'probe']);
  created = true;
  const [row] = JSON.parse((await docker(['inspect', name])).toString());
  if (row.State.Running || row.Config.User !== '10001:10001' || !row.HostConfig.ReadonlyRootfs
      || row.HostConfig.Privileged || (row.HostConfig.CapAdd?.length ?? 0) !== 0
      || !row.HostConfig.CapDrop?.includes('ALL') || row.HostConfig.NetworkMode !== 'none'
      || row.Mounts.length !== 0) throw new Error('The synthetic Compose container is not isolated');
  await verifyCodexSeccomp(row.HostConfig.SecurityOpt);
  // A one-bit change must be rejected; parsing both profiles as JS numbers would lose this difference.
  const altered = row.HostConfig.SecurityOpt.map((value) => value.replace('18446744073707451379', '18446744073707451378'));
  let rejected = false;
  try { await verifyCodexSeccomp(altered); } catch { rejected = true; }
  if (!rejected) throw new Error('The seccomp comparison rounded its uint64 mask');
  const output = (await compose(['run', '-T', '--interactive=false', '--rm', '--no-deps', 'probe', 'python', '-I', '-c',
    "import sys; assert not sys.stdin.isatty(); assert sys.stdin.read()==''; print('COMPOSE_NO_TTY_OK')"])).toString();
  if (!output.includes('COMPOSE_NO_TTY_OK')) throw new Error('The synthetic noninteractive Compose command failed');
  console.log('Compose loaded the reviewed profile exactly; uint64 changes rejected; noninteractive launch verified');
} finally {
  if (created) {
    const [row] = JSON.parse((await docker(['inspect', name])).toString());
    if (row.Config.Labels?.['sabre.owner'] !== 'factory' || row.Config.Labels?.['sabre.kind'] !== 'codex-profile-check'
        || row.Config.Labels?.['com.docker.compose.project'] !== project || row.State.Running) {
      throw new Error('The synthetic Compose container cannot be removed safely');
    }
    await docker(['rm', name]);
  }
}
