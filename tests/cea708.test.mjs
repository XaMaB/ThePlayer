import { test } from 'node:test';
import assert from 'node:assert/strict';
import captionStream from '../vendor/mux.js/caption-stream.cjs';
import { SubtitleCounters, activeCue } from '../src/subtitles/cues.mjs';
const { Cea708Stream } = captionStream;
const window = [0x98, 0x20, 0, 0, 2, 31, 0];
function block(decoder, data, service = 1, pts = 90000) {
  decoder.current708Packet = {
    data,
    ptsVals: Array(Math.ceil(data.length / 2)).fill(pts),
  };
  decoder.pushServiceBlock(service, 0, data.length);
  return decoder.services[service].currentWindow.getText();
}
test('P16 Cyrillic and Latin Extended consume both operands, including control-range bytes', () => {
  const d = new Cea708Stream();
  assert.equal(
    block(d, [...window, 0x18, 0x04, 0x11, 0x18, 0x01, 0x7c, 0x18, 0x01, 0x42]),
    'Бżł',
  );
});
test('P16 low byte is data, not a command; zero high byte emits one character', () => {
  const d = new Cea708Stream();
  assert.equal(
    block(d, [...window, 65, 0x18, 1, 0x88, 0x18, 0, 32, 66]),
    'Aƈ B',
  );
});
test('P16 EUC-KR is explicitly selectable; zero prefix is not a NUL', () => {
  const d = new Cea708Stream({
    captionServices: { SERVICE1: { encoding: 'euc-kr' } },
  });
  assert.equal(block(d, [...window, 0x18, 0xb0, 0xa1, 0x18, 0, 32]), '가 ');
});
test('truncated P16 does not read the next service block or execute an operand', () => {
  const d = new Cea708Stream();
  const data = [...window, 65, 0x18, 4, 0x88, 1];
  d.current708Packet = { data, ptsVals: Array(20).fill(90000) };
  d.pushServiceBlock(1, 0, window.length + 3);
  assert.equal(d.services[1].currentWindow.getText(), 'A');
  assert.equal(d.services[1].currentWindow.visible, 1);
});
test('separate services, hide/clear and live snapshots preserve timestamps', () => {
  const d = new Cea708Stream(),
    events = [];
  d.on('data', (e) => {
    if (e.snapshot) events.push(e);
  });
  block(d, [...window, 65], 1, 90000);
  block(d, [...window, 66], 2, 180000);
  block(d, [0x8a, 1], 1, 270000);
  assert.deepEqual(
    events.map((e) => [e.stream, e.text, e.startPts]),
    [
      ['cc708_1', 'A', 90000],
      ['cc708_2', 'B', 180000],
      ['cc708_1', '', 270000],
    ],
  );
});
test('CEA text snapshots count actual appearance changes and honor clears', () => {
  const c = new SubtitleCounters(),
    a = { pts: 1, duration: 30, text: 'Български', rects: [] },
    b = { ...a, pts: 2 },
    clear = { ...a, pts: 3, text: '' };
  c.present(a, true);
  c.present(b, true);
  assert.equal(c.displayed, 1);
  c.present(clear, false);
  c.present(a, true);
  assert.equal(c.displayed, 2);
  assert.equal(activeCue([a, b, clear], 4), clear);
});
test('SPL overwrites the specified row/column without introducing another line', () => {
  const d = new Cea708Stream();
  block(d, [...window, 65, 66, 67, 0x92, 0, 1, 90]);
  assert.equal(d.services[1].currentWindow.getText(), 'AZC');
  block(d, [0x92, 1, 3, 88]);
  assert.deepEqual(d.services[1].currentWindow.rows, ['AZC', '   X']);
});
test('42 columns survive repeated pen positioning with no artificial wrap at 32', () => {
  const d = new Cea708Stream();
  block(d, [0x98, 0x20, 0, 0, 1, 41, 0]);
  block(d, Array(30).fill(65));
  block(d, [0x92, 0, 30, ...Array(12).fill(66)]);
  assert.deepEqual(d.services[1].currentWindow.rows, [
    'A'.repeat(30) + 'B'.repeat(12),
  ]);
});
test('window snapshots preserve independent anchors, row dimensions and explicit justification', () => {
  const d = new Cea708Stream(),
    events = [];
  d.on('data', (e) => {
    if (e.snapshot) events.push(e);
  });
  block(d, [0x98, 0x20, 0x80 | 75, 30, 1, 41, 0, 0x97, 0xc0, 0, 0, 0, 65]);
  const w = events.at(-1).windows[0];
  assert.deepEqual(
    [
      w.anchorPoint,
      w.anchorHorizontal,
      w.anchorVertical,
      w.relative,
      w.rowCount,
      w.columnCount,
      w.attributes.justify,
    ],
    [0, 30, 75, true, 2, 42, 0],
  );
  block(d, [0x97, 0xc0, 0, 2, 0]);
  assert.equal(events.at(-1).windows[0].attributes.justify, 2);
  assert.equal(w.attributes.justify, 0, 'older snapshots remain immutable');
});
