import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/cea708-service'; export * from './src/engines/hls/cea708-layout';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const { Cea708Service, visibility708, columns708, wipe708 } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundle.outputFiles[0].text).toString('base64')
);
const define = (visible = false, rows = 2, columns = 10) => [
  0x98,
  (visible ? 32 : 0) | 24,
  128,
  0,
  rows - 1,
  columns - 1,
  9,
];
const write = (service, data, time = 0) =>
  service.push(Uint8Array.from(data), time).at(-1);
const text = (value) => [...value].map((c) => c.charCodeAt(0));
test('Fade visibility uses media time, preserves hide content, reverses midway and deletes immediately', () => {
  const s = new Cea708Service(1);
  write(s, [...define(), 0x97, 0, 0, 0, 0x21, ...text('Hello')]);
  const show = write(s, [0x89, 1], 2);
  assert.equal(visibility708(show.windows[0], 2), 0);
  assert.equal(visibility708(show.windows[0], 2.5), 0.5);
  assert.equal(visibility708(show.windows[0], 3), 1);
  const hide = write(s, [0x8a, 1], 2.5);
  assert.equal(hide.windows[0].visible, false);
  assert.equal(visibility708(hide.windows[0], 3), 0.25);
  assert.equal(visibility708(hide.windows[0], 3.5), 0);
  assert.equal(s.screen(3.5).windows.length, 0);
  const back = write(s, [0x8b, 1], 3);
  assert.equal(visibility708(back.windows[0], 3), 0.25);
  assert.equal(visibility708(back.windows[0], 4), 1);
  assert.equal(write(s, [0x8c, 1], 3.25).windows.length, 0);
  assert.equal(
    visibility708(show.windows[0], 2.25),
    0.25,
    'Earlier snapshots remain seekable',
  );
});
test('Wipe direction reverses the clipped edge between showing and hiding', () => {
  const expected = [
    ['inset(0% 50% 0% 0%)', 'inset(0% 0% 0% 50%)'],
    ['inset(0% 0% 0% 50%)', 'inset(0% 50% 0% 0%)'],
    ['inset(0% 0% 50% 0%)', 'inset(50% 0% 0% 0%)'],
    ['inset(50% 0% 0% 0%)', 'inset(0% 0% 50% 0%)'],
  ];
  for (let direction = 0; direction < 4; direction++)
    for (const to of [0, 1])
      assert.equal(
        wipe708({ visibility: { effect: 2, direction, to } }, 0.5),
        expected[direction][to ? 0 : 1],
      );
});
test('Full justification expands word spacing without stretching glyphs or breaking nonbreaking spaces', () => {
  const row = [...'A B C'].map((text) => ({ text, pen: {} }));
  assert.deepEqual(columns708(row, 10, 3), [0, 1, 4.5, 5.5, 9]);
  assert.deepEqual(
    columns708([{ text: 'A' }, { text: '\u00a0' }, { text: 'B' }], 9, 3),
    [3, 4, 5],
  );
  assert.deepEqual(columns708(row, 10, 0), [0, 1, 2, 3, 4]);
});
test('Word wrapping carries styled cells in horizontal and vertical print order, including hyphens', () => {
  for (let direction = 0; direction < 4; direction++) {
    const s = new Cea708Service(1),
      horizontal = direction < 2;
    const rows = horizontal ? 3 : 5,
      columns = horizontal ? 5 : 3;
    write(s, [
      ...define(true, rows, columns),
      0x97,
      0,
      0,
      0x40 | (direction << 4) | (horizontal ? 12 : 4),
      0,
      0x92,
      direction === 3 ? 4 : 0,
      direction === 1 ? 4 : 0,
      ...text('AA BBC'),
    ]);
    const w = s.windows.get(0);
    const line = (n) =>
      Array.from({ length: 5 }, (_, i) => {
        const p = direction % 2 ? 4 - i : i;
        return (horizontal ? w.cells[n][p] : w.cells[p][n])?.text ?? ' ';
      })
        .join('')
        .trimEnd();
    assert.equal(line(0), 'AA');
    assert.equal(line(1), 'BBC');
  }
  const s = new Cea708Service(1);
  write(s, [...define(true, 2, 5), 0x97, 0, 0, 0x4c, 0, ...text('AA-BBC')]);
  assert.equal(
    s.windows
      .get(0)
      .cells[0].map((c) => c?.text ?? ' ')
      .join('')
      .trimEnd(),
    'AA-',
  );
  assert.equal(
    s.windows
      .get(0)
      .cells[1].map((c) => c?.text ?? ' ')
      .join('')
      .trimEnd(),
    'BBC',
  );
});
