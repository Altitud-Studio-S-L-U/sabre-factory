import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function command(executable, args, binary = false) {
  const result = spawnSync(executable, args, { cwd: root, windowsHide: true, encoding: binary ? undefined : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Release preparation failed: ${executable} ${args[0]}`);
  return result.stdout;
}

export function webInventory(licenses, version) {
  const components = Object.entries(licenses).flatMap(([license, packages]) => packages.flatMap((item) => item.versions.map((value) => ({
    type: 'library', name: item.name, version: value,
    purl: `pkg:npm/${item.name.replace(/^@/, '%40')}@${encodeURIComponent(value)}`,
    licenses: [{ license: { name: license } }],
  })))).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return { bomFormat: 'CycloneDX', specVersion: '1.5', version: 1,
    metadata: { component: { type: 'application', name: 'sabre-factory-web', version } }, components };
}

async function main() {
  if (command('git', ['status', '--porcelain']).trim()) throw new Error('Commit the reviewed candidate before preparing release artifacts.');
  const commit = command('git', ['rev-parse', 'HEAD']).trim();
  const { version } = JSON.parse(await readFile(resolve(root, 'web/package.json'), 'utf8'));
  const output = resolve(root, 'work/release');
  await mkdir(output, { recursive: true });
  const artifacts = new Map();
  artifacts.set(`sabre-factory-${version}-${commit.slice(0, 12)}.tar.gz`, command('git', ['archive', '--format=tar.gz', 'HEAD'], true));
  const lock = await readFile(resolve(root, 'backend/uv.lock'));
  const imageLock = command('docker', ['run', '--rm', '--network', 'none', 'sabre-factory-dev:local', 'cat', '/app/uv.lock'], true);
  if (!lock.equals(imageLock)) throw new Error('Rebuild the development image from this candidate lockfile.');
  const python = command('docker', ['run', '--rm', '--network', 'none', 'sabre-factory-dev:local', 'uv', 'export', '--frozen', '--no-dev', '--no-emit-project', '--format', 'cyclonedx1.5']);
  artifacts.set('backend.cdx.json', JSON.stringify(JSON.parse(python), null, 2) + '\n');
  const licenses = JSON.parse(await readFile(resolve(root, 'work/web-licenses.json'), 'utf8'));
  artifacts.set('web.cdx.json', JSON.stringify(webInventory(licenses, version), null, 2) + '\n');
  artifacts.set('source.json', JSON.stringify({ version: 1, repository: 'https://github.com/Altitud-Studio-S-L-U/sabre-factory', commit, package_version: version }, null, 2) + '\n');
  const checksums = [];
  for (const [name, bytes] of artifacts) {
    await writeFile(resolve(output, name), bytes);
    checksums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${basename(name)}`);
  }
  await writeFile(resolve(output, 'SHA256SUMS'), checksums.join('\n') + '\n');
  console.log(`Prepared ${artifacts.size} candidate artifacts with SHA-256 checksums. Publication remains a separate release gate.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
