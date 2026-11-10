import { docker, ownedVolume, root } from './bootstrap.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const codexVolumes = { bridge: 'sabre-factory-codex-bridge', home: 'sabre-factory-codex-home' };
const python = 'python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527';
export const codexSeccompDigest = '37a027b34987214d9a0ca4c8608f8a4aa27bde08fc1bac67e7836c20bbc5f0b0';

export function readCodexSeccomp() {
  // Preserve uint64 masks verbatim; JavaScript JSON parsing would round them.
  const profile = readFileSync(resolve(root, 'infra/codex-seccomp.json'));
  if (createHash('sha256').update(profile).digest('hex') !== codexSeccompDigest) {
    throw new Error('The reviewed Codex seccomp profile changed');
  }
  return profile;
}

export async function prepareCodexPolicy() {
  readCodexSeccomp();
}

export async function codexSeccompClientPath() {
  readCodexSeccomp();
  return resolve(root, 'infra/codex-seccomp.json');
}

export async function verifyCodexSeccomp(securityOptions) {
  const applied = securityOptions?.filter((option) => option.startsWith('seccomp=')) ?? [];
  if (applied.length !== 1) throw new Error('The Codex runner is missing its reviewed seccomp profile');
  // Only the outer strings pass through JavaScript JSON. Python compares the inner uint64 values exactly.
  const input = Buffer.from(JSON.stringify({ expected: readCodexSeccomp().toString('utf8'), actual: applied[0].slice(8) }));
  const program = "import json,sys; p=json.load(sys.stdin); assert json.loads(p['expected'])==json.loads(p['actual']); print('profile verified')";
  try {
    await docker(['run', '--rm', '-i', '--network', 'none', '--read-only', '--memory', '64m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', python, 'python', '-I', '-c', program], input);
  } catch { throw new Error('The effective Codex seccomp profile differs from the reviewed profile'); }
}

export async function withCliBuildImages(provider, controlTag, build) {
  if (!['codex', 'claude'].includes(provider)) throw new Error('Unknown isolated CLI build target');
  const control = (await docker(['image', 'inspect', controlTag, '--format', '{{.Id}}'])).toString().trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(control)) throw new Error('Missing pinned control image');
  const suffix = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const aliases = [];
  try {
    for (const [name, id] of [['control', control]]) {
      const alias = `sabre-factory-${provider}-${name}-${suffix}:local`;
      await docker(['image', 'tag', id, alias]); aliases.push(alias);
      if ((await docker(['image', 'inspect', alias, '--format', '{{.Id}}'])).toString().trim() !== id) throw new Error('A pinned build input changed');
    }
    // BuildKit resolves local tags without a registry pull; each alias names a verified immutable id.
    return await build(['--build-arg', `SABRE_CONTROL_IMAGE=${aliases[0]}`]);
  } finally {
    for (const alias of aliases) await docker(['image', 'rm', alias]);
  }
}

export function withCodexBuildImages(controlTag, build) {
  return withCliBuildImages('codex', controlTag, build);
}

export async function provisionCodex(names = codexVolumes) {
  await ownedVolume(names.bridge, 'codex-bridge');
  await ownedVolume(names.home, 'codex-home');
  const program = String.raw`
import os,pathlib,re,secrets,stat
uid=10001
for base in (pathlib.Path('/bridge'),pathlib.Path('/home')):
 info=base.stat()
 if info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o755 and next(base.iterdir(),None) is None:
  os.chmod(base,0o700); os.chown(base,uid,uid)
 else:
  if info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o700: raise SystemExit(2)
token=pathlib.Path('/bridge/token')
if not token.exists() and not token.is_symlink():
 value=secrets.token_urlsafe(32).encode()
 fd=os.open(token,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o400)
 with os.fdopen(fd,'wb') as stream: stream.write(value); stream.flush(); os.fsync(stream.fileno())
 os.chown(token,uid,uid)
info=token.lstat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=uid or stat.S_IMODE(info.st_mode)!=0o400: raise SystemExit(3)
if not re.fullmatch(rb'[A-Za-z0-9_-]{43}',token.read_bytes()): raise SystemExit(4)
print('Codex bootstrap ready')
`;
  await docker(['run', '--rm', '--network', 'none', '--read-only', '--memory', '64m', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
    '--mount', `type=volume,source=${names.bridge},target=/bridge,volume-nocopy`,
    '--mount', `type=volume,source=${names.home},target=/home,volume-nocopy`, python, 'python', '-I', '-c', program]);
}
