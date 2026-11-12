// Content digest of the console build inputs. The Docker build context excludes .git, so a commit SHA is
// not available inside the image; the same inputs give the same identifier on the host and in the image.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const files = ['index.html', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'tsconfig.json'];

function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test') walk(path);
    } else if (!/\.test\.[jt]sx?$/.test(name)) files.push(relative(root, path));
  }
}

export function buildId() {
  files.length = 5;
  walk(join(root, 'src'));
  const hash = createHash('sha256');
  // Normalise separators and line endings so Windows and Linux checkouts produce the same digest.
  for (const file of files.map((item) => item.split(sep).join('/')).sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(buildId());
