import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const upstream = process.env.MOQ_SOURCE ?? path.join(root, '.cache/moq');
const options = {
  noEmit: true,
  resolveJsonModule: true,
  strict: true,
  allowJs: true,
  checkJs: false,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  lib: ['lib.esnext.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
  paths: {
    pako: [path.join(root, 'node_modules/pako/dist/pako.d.ts')],
    ...Object.fromEntries(
      ['net', 'clock', 'signals', 'pattern', 'qmux'].map((name) => [
        '@moq/' + name,
        [path.join(upstream, 'js', name, 'src/index.ts')],
      ]),
    ),
  },
};
const program = ts.createProgram(
  [path.join(root, 'src/player.ts'), path.join(root, 'demo/app.ts')],
  options,
);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
} else console.log('TypeScript checks passed.');
