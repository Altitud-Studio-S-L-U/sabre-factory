import { posix } from 'node:path';
import { docker } from './bootstrap.mjs';

export const stateBootstrapImage = 'python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527';
export const executorStateProject = 'sabre-factory';

function volumeName(project) {
  if (!/^sabre-factory(?:-executor-state-check-[0-9]+)?$/.test(project)) throw new Error('Unexpected executor state project');
  return `${project}_executor-state`;
}

export async function inspectExecutorState(project = executorStateProject) {
  const name = volumeName(project);
  const [volume] = JSON.parse((await docker(['volume', 'inspect', name])).toString());
  if (volume?.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local'
      || Object.keys(volume.Options ?? {}).length
      || volume.Labels?.['com.docker.compose.project'] !== project
      || volume.Labels?.['com.docker.compose.volume'] !== 'executor-state'
      || !posix.isAbsolute(volume.Mountpoint ?? '') || volume.Mountpoint.split('/').includes('..')
      || !volume.Mountpoint.endsWith(`/${name}/_data`)) {
    throw new Error('Executor state is not an owned local Docker volume');
  }
  return name;
}

export async function provisionExecutorState(project = executorStateProject) {
  const name = volumeName(project);
  const names = (await docker(['volume', 'ls', '--format', '{{.Name}}'])).toString().trim().split(/\r?\n/);
  if (!names.includes(name)) {
    await docker(['volume', 'create', '--label', `com.docker.compose.project=${project}`,
      '--label', 'com.docker.compose.volume=executor-state', name]);
  }
  await inspectExecutorState(project);
  // Correct only the known copy-up ownership mismatch. Existing entries are
  // inspected without opening them; incompatible data requires explicit recovery.
  const program = String.raw`
import json,os,pathlib,stat
root=pathlib.Path('/state')
entry=root.lstat()
identity=(entry.st_uid,entry.st_gid,stat.S_IMODE(entry.st_mode))
if not stat.S_ISDIR(entry.st_mode) or identity not in {(0,0,0o700),(0,0,0o755),(10001,10001,0o755)}:
 raise SystemExit('Unexpected executor state directory')
children=0
for child in root.iterdir():
 item=child.lstat(); children+=1
 if not stat.S_ISREG(item.st_mode) or (item.st_uid,item.st_gid,stat.S_IMODE(item.st_mode))!=(0,0,0o600):
  raise SystemExit('Executor state entries require explicit recovery')
if identity!=(0,0,0o700):
 os.chown(root,0,0,follow_symlinks=False)
 os.chmod(root,0o700,follow_symlinks=False)
entry=root.lstat()
if (entry.st_uid,entry.st_gid,stat.S_IMODE(entry.st_mode))!=(0,0,0o700):
 raise SystemExit('Executor state ownership was not corrected')
print(json.dumps({'owner_uid':0,'owner_gid':0,'mode':448,'entries_preserved':children}))
`;
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--memory', '64m',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,source=${name},target=/state,volume-nocopy`,
    stateBootstrapImage, 'python', '-I', '-c', program]);
}
