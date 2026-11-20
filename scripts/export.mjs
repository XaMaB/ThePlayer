import { cp, mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = process.argv[2] && path.resolve(process.argv[2]);
if (!destination)
  throw new Error('Usage: npm run export -- /path/to/new-directory');
if (destination === root || destination.startsWith(root + path.sep))
  throw new Error('Export outside the working package.');
try {
  await access(destination);
  throw new Error('Destination already exists; choose a new directory.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(destination, { recursive: true });
const files = [
  '.github',
  'assets',
  'src',
  'demo',
  'scripts',
  'tests',
  'docs',
  'package.json',
  'package-lock.json',
  'server.mjs',
  'README.md',
  'NOTICE',
  'LICENSE-APACHE',
  'LICENSE-MIT',
  'THIRD-PARTY-pako-LICENSE',
  '.gitignore',
  '.prettierrc.json',
];
for (const name of files)
  await cp(path.join(root, name), path.join(destination, name), {
    recursive: true,
  });
console.log(`ThePlayer source exported to ${destination}`);
