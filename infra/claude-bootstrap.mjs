import { docker, ownedVolume } from './bootstrap.mjs';

export const claudeVolumes = { bridge: 'sabre-factory-claude-bridge', home: 'sabre-factory-claude-home' };
const python = 'python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527';

export function assertPlainClaudeVolume(volume, name, kind) {
  if (volume.Name !== name || volume.Driver !== 'local' || volume.Scope !== 'local'
      || Object.keys(volume.Options ?? {}).length !== 0 || volume.Labels?.['sabre.owner'] !== 'factory'
      || volume.Labels?.['sabre.kind'] !== `claude-${kind}` || !volume.Mountpoint?.startsWith('/')
      || !volume.Mountpoint.endsWith(`/${name}/_data`) || volume.Mountpoint.split('/').includes('..')) {
    throw new Error('Claude requires an ordinary, SABRE-owned local Docker volume without host bind options');
  }
}

async function validateVolume(name, kind) {
  await ownedVolume(name, `claude-${kind}`);
  const [volume] = JSON.parse((await docker(['volume', 'inspect', name])).toString());
  assertPlainClaudeVolume(volume, name, kind);
}

async function provision(names, includeHome) {
  await validateVolume(names.bridge, 'bridge');
  if (includeHome) await validateVolume(names.home, 'home');
  const program = String.raw`
import os,pathlib,re,secrets,stat,sys
uid=10001
bases=[pathlib.Path('/bridge')]
if sys.argv[1]=='home': bases.append(pathlib.Path('/home'))
for base in bases:
 info=base.lstat()
 if not stat.S_ISDIR(info.st_mode): raise SystemExit(2)
 if info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o755 and next(base.iterdir(),None) is None:
  os.chmod(base,0o700); os.chown(base,uid,uid)
 elif info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(3)
token=pathlib.Path('/bridge/token')
if not token.exists() and not token.is_symlink():
 value=secrets.token_urlsafe(32).encode()
 fd=os.open(token,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
 with os.fdopen(fd,'wb') as stream: stream.write(value); stream.flush(); os.fsync(stream.fileno())
 os.chown(token,uid,uid)
info=token.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o400: raise SystemExit(4)
if not re.fullmatch(rb'[A-Za-z0-9_-]{43}',token.read_bytes()): raise SystemExit(5)
`;
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--memory', '64m', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,source=${names.bridge},target=/bridge,volume-nocopy`,
    ...(includeHome ? ['--mount', `type=volume,source=${names.home},target=/home,volume-nocopy`] : []),
    python, 'python', '-I', '-c', program, includeHome ? 'home' : 'bridge']);
}

export function provisionClaudeBridge(names = claudeVolumes) {
  return provision(names, false);
}

export function provisionClaude(names = claudeVolumes) {
  return provision(names, true);
}
