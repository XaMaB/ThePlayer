import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const compiled = await build({
  entryPoints: [
    new URL('../src/engines/hls/cea608.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const { Cea608Decoder, row608Text, cea608Styles } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text).toString('base64')
);
const parity = (n) => {
  let bits = 0;
  for (let v = n; v; v >>>= 1) bits ^= v & 1;
  return bits ? n : n | 128;
};
const feed = (d, pairs) =>
  pairs.forEach(([a, b], i) => d.push(parity(a), parity(b), i / 30));
test('608 background attributes replace the preceding space without shifting subsequent text', () => {
  for (let id = 0; id < 16; id++) {
    const d = new Cea608Decoder();
    feed(d, [
      [0x14, 0x29],
      [65, 32],
      [0x10, 0x20 + id],
      [0x10, 0x20 + id],
      [66, 0],
    ]);
    const row = d.screens(1)[0].rows[0];
    assert.equal(row.cells.map((c) => c.char).join(''), 'A B');
    assert.equal(row.cells[0].background, 14);
    assert.equal(row.cells[1].background, id);
    assert.equal(row.cells[2].background, id);
    assert.match(row608Text(row), new RegExp('cea608-bg' + id + '>'));
  }
});
test('608 transparency and black foreground preserve background state and reset on a new PAC row', () => {
  const d = new Cea608Decoder();
  feed(d, [
    [0x14, 0x29],
    [65, 32],
    [0x10, 0x28],
    [66, 32],
    [0x17, 0x2f],
    [67, 32],
    [0x17, 0x2d],
    [68, 0],
  ]);
  const row = d.screens(1)[0].rows[0];
  assert.equal(row.cells.at(-1).background, 16);
  assert.equal(row.cells.at(-1).color, 'black');
  assert.equal(row.cells.at(-1).underline, true);
  assert.equal(row.cells.find((c) => c.char === 'C').background, 8);
  feed(d, [
    [0x11, 0x40],
    [69, 0],
  ]);
  assert.equal(
    d.screens(2)[0].rows.find((r) => r.row === 0).cells[0].background,
    14,
  );
  const copy = d.clone();
  assert.deepEqual(copy.screens(2), d.screens(2));
  assert.match(cea608Styles(), /rgba\(255,0,0,0.5\)/);
  assert.match(cea608Styles(), /cea608-bg16.*transparent/);
});
