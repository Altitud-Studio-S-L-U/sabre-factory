import { docker } from './bootstrap.mjs';
import { inspectExecutorState, provisionExecutorState, stateBootstrapImage } from './executor-state.mjs';

const project = `sabre-factory-executor-state-check-${process.pid}`;
const volume = `${project}_executor-state`;
const legacyImage = `${project}:local`;
const image = (await docker(['image', 'inspect', 'sabre-factory-dev:local', '--format', '{{.Id}}'])).toString().trim();
const probe = String.raw`
import errno,json,os,pathlib,stat,sys
from sabre.executor import DockerBroker
root=pathlib.Path('/workspaces'); target=root/'fixture.snapshot.json'
status=dict(line.split(':',1) for line in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert os.getuid()==0 and int(status['CapEff'],16)==0 and status['NoNewPrivs'].strip()=='1'
assert os.statvfs('/').f_flag & os.ST_RDONLY
try:
 broker=DockerBroker(root,docker_client=object())
 if sys.argv[1]=='write': broker._atomic_json(target,{'fixture':'durable snapshot'})
 assert json.loads(target.read_text())=={'fixture':'durable snapshot'}
 entry=target.lstat(); directory=root.lstat()
 assert (entry.st_uid,entry.st_gid,stat.S_IMODE(entry.st_mode))==(0,0,0o600)
 print(json.dumps({'write_errno':0,'file_inode':entry.st_ino,'directory_uid':directory.st_uid,'directory_mode':stat.S_IMODE(directory.st_mode)}))
except OSError as error:
 print(json.dumps({'write_errno':error.errno}))
`;
async function runProbe(operation) {
  return JSON.parse((await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m',
    '--mount', `type=volume,source=${volume},target=/workspaces`, image, 'python', '-I', '-c', probe, operation])).toString());
}
let created = false;
let built = false;
try {
  const volumes = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).toString().split(/\r?\n/);
  if (volumes.includes(volume)) throw new Error('Executor state fixture already exists');
  await docker(['volume', 'create', '--label', `com.docker.compose.project=${project}`,
    '--label', 'com.docker.compose.volume=executor-state', volume]); created = true;
  // Docker copy-up, not a mocked permission check: reproduce the deployed legacy image's directory.
  await docker(['build', '-t', legacyImage, '-'], `FROM ${stateBootstrapImage}\nRUN mkdir /workspaces && chown 10001:10001 /workspaces && chmod 0755 /workspaces\n`);
  built = true;
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--mount', `type=volume,source=${volume},target=/workspaces`,
    legacyImage, 'python', '-I', '-c', "import os; s=os.stat('/workspaces'); assert (s.st_uid,s.st_gid,s.st_mode & 0o777)==(10001,10001,0o755)"]);
  const before = await runProbe('write');
  if (before.write_errno !== 13) throw new Error('Legacy Docker copy-up did not reproduce the broker write failure');
  await provisionExecutorState(project);
  const corrected = await runProbe('write');
  if (corrected.write_errno || corrected.directory_uid !== 0 || corrected.directory_mode !== 0o700) {
    throw new Error('Provisioned executor state could not persist and fsync a snapshot without capabilities');
  }
  await provisionExecutorState(project);
  if (JSON.stringify(await runProbe('read')) !== JSON.stringify(corrected)) throw new Error('Repeated provisioning changed persisted state');
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'CHOWN',
    '--security-opt', 'no-new-privileges', '--mount', `type=volume,source=${volume},target=/state,volume-nocopy`,
    stateBootstrapImage, 'python', '-I', '-c', "import os,pathlib; p=pathlib.Path('/state/foreign.json'); p.write_text('synthetic'); p.chmod(0o600); os.chown(p,10001,10001)"]);
  let rejected = false;
  try { await provisionExecutorState(project); } catch { rejected = true; }
  if (!rejected) throw new Error('Provisioning recursively changed an incompatible state entry');
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--mount', `type=volume,source=${volume},target=/state,volume-nocopy,readonly`, stateBootstrapImage,
    'python', '-I', '-c', "import os; s=os.lstat('/state/foreign.json'); assert (s.st_uid,s.st_gid,s.st_mode & 0o777)==(10001,10001,0o600)"]);
  console.log('Executor state verified: legacy copy-up denied writes; root without capabilities persists/fsyncs after scoped provisioning; repeat and foreign-entry rejection preserve data.');
} finally {
  if (created) { await inspectExecutorState(project); await docker(['volume', 'rm', volume]); }
  if (built) await docker(['image', 'rm', legacyImage]);
}
