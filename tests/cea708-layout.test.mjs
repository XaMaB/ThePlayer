import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layout708Window, draw708 } from '../src/subtitles/cea708/render.mjs';
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6);
const w = {
  relative: true,
  anchorPoint: 0,
  anchorHorizontal: 30,
  anchorVertical: 75,
  rowCount: 2,
  columnCount: 42,
  pen: { penSize: 0 },
  attributes: { justify: 0 },
  rows: ['A short row', 'A much longer row'],
};
test('source anchor and left alignment retain one start position for rows of different lengths', () => {
  const b = layout708Window(w, 1920, 1080, 24);
  near(b.left, 1920 * (0.05 + (0.9 * 30) / 99));
  near(b.top, 1080 * (0.05 + (0.9 * 75) / 99));
  assert.equal(b.width, 42 * 24);
  assert.equal(b.align, 'left');
  const calls = [],
    context = {
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      fillRect() {},
      measureText: (s) => ({ width: s.length * 24 }),
      fillText(s, x, y) {
        calls.push([s, x, y, this.textAlign]);
      },
    };
  assert.ok(draw708(context, { windows: [w] }, 1920, 1080));
  assert.equal(calls[0][1], calls[1][1]);
  assert.equal(calls[0][3], 'left');
  assert.deepEqual(
    calls.map((x) => x[0]),
    w.rows,
  );
});
test('all nine window anchors are independent of text alignment', () => {
  for (let i = 0; i < 9; i++) {
    const b = layout708Window(
      { ...w, anchorPoint: i, attributes: { justify: 2 } },
      1920,
      1080,
      24,
    );
    near(b.left, 1920 * (0.05 + (0.9 * 30) / 99) - ((i % 3) / 2) * b.width);
    near(
      b.top,
      1080 * (0.05 + (0.9 * 75) / 99) - (Math.floor(i / 3) / 2) * b.height,
    );
    assert.equal(b.align, 'center');
  }
});
test('absolute anchors account for aspect ratio, and small pen size reduces line height', () => {
  for (const [width, horizontal] of [
    [1920, 209],
    [1440, 159],
  ]) {
    const b = layout708Window(
      {
        ...w,
        relative: false,
        anchorHorizontal: horizontal,
        anchorVertical: 74,
      },
      width,
      1080,
      24,
    );
    assert.ok(Math.abs(b.left - width * 0.95) < 1e-6);
    assert.ok(Math.abs(b.top - 1080 * 0.95) < 1e-6);
  }
  const small = layout708Window(w, 1920, 1080, 24),
    normal = layout708Window({ ...w, pen: { penSize: 1 } }, 1920, 1080, 24);
  near(small.fontSize, normal.fontSize * 0.75);
});
