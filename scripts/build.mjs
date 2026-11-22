import { build } from 'esbuild';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { version } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.resolve(root, process.env.THEPLAYER_DIST ?? 'dist');
const upstream = process.env.MOQ_SOURCE ?? path.join(root, '.cache/moq');
const revision = 'caf6ebc05d0b56a5689af1df431dd13804aaa1a2';
let actual;
try {
  actual = execFileSync('git', ['-C', upstream, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
} catch {
  throw new Error('Run npm run bootstrap before building (or set MOQ_SOURCE).');
}
if (actual !== revision)
  throw new Error(`Expected moq-dev ${revision}, got ${actual}`);
const alias = Object.fromEntries(
  ['net', 'clock', 'signals', 'pattern', 'qmux'].map((name) => [
    '@moq/' + name,
    path.join(upstream, 'js', name, 'src/index.ts'),
  ]),
);
await mkdir(output, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: {
    app: 'demo/app.ts',
    player: 'src/player.ts',
    core: 'src/core/player.ts',
    hls: 'src/engines/hls/engine.ts',
    dash: 'src/engines/dash/engine.ts',
  },
  outdir: output,
  bundle: true,
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  alias,
  nodePaths: [path.join(root, 'node_modules')],
  banner: {
    js: `/*! ThePlayer v${version} | Apache-2.0. Third-party notices: NOTICE */`,
  },
});
await Promise.all(
  ['index.html', 'style.css'].map((name) =>
    copyFile(path.join(root, 'demo', name), path.join(output, name)),
  ),
);
await Promise.all(
  ['NOTICE', 'LICENSE-APACHE', 'LICENSE-MIT', 'THIRD-PARTY-pako-LICENSE'].map(
    (name) => copyFile(path.join(root, name), path.join(output, name)),
  ),
);
await Promise.all(
  [
    ['logo.svg', 'favicon.svg'],
    ['favicon.ico', 'favicon.ico'],
    ['apple-touch-icon.png', 'apple-touch-icon.png'],
  ].map(([source, destination]) =>
    copyFile(
      path.join(root, 'assets/brand', source),
      path.join(output, destination),
    ),
  ),
);
const embed = (await readFile(path.join(root, 'demo/index.html'), 'utf8'))
  .replace('<body>', '<body data-embed>')
  .replace('ThePlayer · Demo', 'ThePlayer · Embed');
await writeFile(path.join(output, 'embed.html'), embed);

await writeFile(
  path.join(output, 'version.json'),
  JSON.stringify({ name: 'ThePlayer', version }) + '\n',
);
