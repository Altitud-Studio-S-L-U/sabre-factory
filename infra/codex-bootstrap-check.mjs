import { docker, ownedVolume } from './bootstrap.mjs';
import { provisionCodex } from './codex-bootstrap.mjs';

const owner = `sabre-factory-codex-bootstrap-check-${process.pid}`;
const names = { bridge: `${owner}-bridge`, home: `${owner}-home` };
const python = 'python:3.14.10-slim-bookworm@sha256:516b51cb9db2ef061e465c803e50f64361b82cefd91e525b889b967b83e83527';
const inspect = "import hashlib,pathlib,stat,json; p=pathlib.Path('/bridge/token'); s=p.stat(); h=pathlib.Path('/home').stat(); print(json.dumps({'digest':hashlib.sha256(p.read_bytes()).hexdigest(),'uid':s.st_uid,'mode':stat.S_IMODE(s.st_mode),'home_uid':h.st_uid,'home_mode':stat.S_IMODE(h.st_mode)}))";
async function run(program, writable = false) {
  return docker(['run', '--rm', '--network', 'none', '--read-only', '--memory', '64m', '--cap-drop', 'ALL',
    '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--mount', `type=volume,source=${names.bridge},target=/bridge,volume-nocopy${writable ? '' : ',readonly'}`,
    '--mount', `type=volume,source=${names.home},target=/home,volume-nocopy,readonly`, python, 'python', '-I', '-c', program]);
}
try {
  await provisionCodex(names);
  const before = JSON.parse((await run(inspect)).toString());
  await provisionCodex(names);
  const after = JSON.parse((await run(inspect)).toString());
  if (JSON.stringify(before) !== JSON.stringify(after) || before.uid !== 10001 || before.mode !== 0o400
      || before.home_uid !== 10001 || before.home_mode !== 0o700) throw new Error('Codex private-file provisioning changed an identity or permission: ' + JSON.stringify({
        identity_preserved: before.digest === after.digest, before: { ...before, digest: undefined }, after: { ...after, digest: undefined } }));
  await run("import os; os.chmod('/bridge/token',0o600)", true);
  let rejected = false;
  try { await provisionCodex(names); } catch { rejected = true; }
  if (!rejected) throw new Error('Codex provisioning accepted an unexpected existing permission');
  const corrupt = JSON.parse((await run(inspect)).toString());
  if (corrupt.digest !== before.digest || corrupt.mode !== 0o600) throw new Error('Codex provisioning overwrote invalid existing material');
  console.log('Verified repeatable Codex bootstrap, private permissions and conflict protection. No real session used.');
} finally {
  for (const [kind, name] of Object.entries(names)) {
    // This verifies labels before removing only this invocation's disposable volumes.
    await ownedVolume(name, `codex-${kind}`);
    await docker(['volume', 'rm', name]);
  }
}
