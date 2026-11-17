import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const revision = 'caf6ebc05d0b56a5689af1df431dd13804aaa1a2';
export const checkout = fileURLToPath(
  new URL('../.cache/moq', import.meta.url),
);
await mkdir(checkout, { recursive: true });
const git = (...args) =>
  execFileSync('git', ['-C', checkout, ...args], { stdio: 'inherit' });
git('init');
git('fetch', '--depth=1', 'https://github.com/moq-dev/moq.git', revision);
git('checkout', '--detach', 'FETCH_HEAD');
