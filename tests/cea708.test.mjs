import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function load(name) {
  const result = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(result.outputFiles[0].text).toString('base64')
  );
}
const { DtvccPackets, serviceBlocks708, commandLength708, p16Character } =
  await load('cea708-packets');
const { Cea708Service } = await load('cea708-service');
const define = (id = 0, visible = true, rows = 2, columns = 12, style = 1) => [
  0x98 + id,
  (visible ? 32 : 0) | 24,
  0x80 | 80,
  20,
  (6 << 4) | (rows - 1),
  columns - 1,
  (style << 3) | 1,
];
const bytes = (text) => [...text].map((s) => s.charCodeAt(0));
const plain = (service, id = 0) =>
  service.windows
    .get(id)
    .cells.map((row) =>
      row
        .map((cell) => cell?.text ?? ' ')
        .join('')
        .trimEnd(),
    )
    .join('\n')
    .trimEnd();

test('DTVCC assembles across frames, preserves services and resets on sequence loss', () => {
  const packets = new DtvccPackets();
  assert.deepEqual(
    packets.push({ type: 2, first: 0, second: 0, time: 0 }).blocks,
    [],
  );
  assert.deepEqual(
    packets.push({ type: 3, first: 3, second: 0x22, time: 1 }).blocks,
    [],
  );
  packets.push({ type: 2, first: 0x41, second: 0x42, time: 1.04 });
  const clone = packets.clone();
  const result = clone.push({ type: 2, first: 0, second: 0, time: 1.08 });
  assert.deepEqual(result.blocks, [
    { service: 1, time: 1, data: Uint8Array.of(65, 66) },
  ]);
  assert.equal(
    clone.push({ type: 3, first: 0xc1, second: 0, time: 2 }).reset,
    true,
  );
  assert.equal(
    clone.push({ type: 3, first: 1, second: 0, time: 3 }).reset,
    false,
  );
  assert.deepEqual(serviceBlocks708(Uint8Array.of(0xe1, 63, 65), 0), [
    { service: 63, time: 0, data: Uint8Array.of(65) },
  ]);
  assert.throws(
    () => serviceBlocks708(Uint8Array.of(0xe1, 6, 65), 0),
    /extended/,
  );
  assert.throws(
    () => serviceBlocks708(Uint8Array.of(0x22, 65), 0),
    /Truncated/,
  );
});

test('708 tokenization protects parameters, extended command lengths and split P16', () => {
  assert.equal(commandLength708([0x18, 0x8e]), undefined);
  assert.equal(commandLength708([0x18, 0x8e, 0x8f]), 3);
  assert.equal(commandLength708([0x10, 0x87, ...Array(4).fill(0)]), 6);
  assert.equal(commandLength708([0x10, 0x91, 2, 65, 66]), 5);
  assert.equal(commandLength708([0x98, ...Array(6).fill(0)]), 7);
  assert.equal(p16Character(0, 0x7f), '♪');
  assert.equal(p16Character(4, 0x16), 'Ж');
  assert.equal(p16Character(0xd8, 0), '\ufffd');
  assert.equal(p16Character(0xb0, 0xa1, 'euc-kr'), '가');
  assert.equal(p16Character(0x81, 0x20, 'euc-kr'), '\ufffd');
});

test('708 windows retain geometry, repeated definitions, styled cells and separate services', () => {
  const s = new Cea708Service(1);
  s.push(
    Uint8Array.from([...define(), ...bytes('Hello'), 0x90, 5, 0xc3, 0x18, 4]),
    1,
  );
  s.push(Uint8Array.of(0x16), 1.1);
  assert.equal(plain(s), 'HelloЖ');
  assert.equal(s.windows.get(0).cells[0][5].pen.italic, true);
  s.push(Uint8Array.from(define()), 2);
  assert.equal(plain(s), 'HelloЖ');
  assert.deepEqual(
    [
      s.windows.get(0).anchor,
      s.windows.get(0).horizontal,
      s.windows.get(0).vertical,
    ],
    [6, 20, 80],
  );
  const copy = s.clone();
  copy.push(Uint8Array.of(0x88, 1), 3);
  assert.equal(plain(copy), '');
  assert.equal(plain(s), 'HelloЖ');
  s.push(
    Uint8Array.from([...define(1, false), ...bytes('Hidden'), 0x89, 2]),
    4,
  );
  assert.equal(s.screen(4).windows.length, 2);
  s.push(Uint8Array.of(0x8a, 1, 0x8c, 2), 5);
  assert.equal(s.screen(5).windows.length, 0);
  assert.equal(s.windows.size, 1);
});

test('708 delay expires on media time and cancel/reset bypass only real command tokens', () => {
  const s = new Cea708Service(1);
  s.push(Uint8Array.from([...define(), 0x8d, 10, ...bytes('Later')]), 1);
  assert.equal(plain(s), '');
  assert.equal(s.advance(1.9).length, 0);
  assert.equal(s.advance(2)[0].time, 2);
  assert.equal(plain(s), 'Later');
  s.push(Uint8Array.from([0x8d, 100, ...bytes('X'), 0x18, 0x8e]), 3);
  assert.equal(plain(s), 'Later');
  s.push(Uint8Array.of(0x8f), 3.1);
  assert.equal(plain(s), 'Later');
  s.push(Uint8Array.of(0x8e), 3.2);
  assert.equal(plain(s), 'LaterX' + String.fromCharCode(0x8e8f));
  s.push(
    Uint8Array.from([0x8d, 100, ...bytes('Discard'), 0x8f, ...define(), 65]),
    4,
  );
  assert.equal(plain(s), 'A');
  assert.equal(s.advance(100).length, 0);
});

test('708 wrap keeps words and CR scrolls within defined rows', () => {
  const s = new Cea708Service(1);
  s.push(
    Uint8Array.from([...define(0, true, 2, 8, 4), ...bytes('One two more')]),
    1,
  );
  assert.equal(plain(s), 'One two\nmore');
  s.push(Uint8Array.from([13, ...bytes('Next')]), 2);
  assert.equal(plain(s), 'more\nNext');
  s.push(Uint8Array.of(8), 3);
  assert.equal(plain(s), 'more\nNex');
});

const { Cea708Timeline } = await load('cea708-timeline');
const packet = (commands, time, sequence = 0) => {
  const data = [0x20 | commands.length, ...commands];
  if (data.length % 2 === 0) data.push(0);
  const result = [
    {
      time,
      type: 3,
      first: (sequence << 6) | ((data.length + 1) / 2),
      second: data[0],
    },
  ];
  for (let i = 1; i < data.length; i += 2)
    result.push({ time, type: 2, first: data[i], second: data[i + 1] });
  return result;
};
const screenText = (event) =>
  event.windows
    .map((w) =>
      w.cells
        .map((row) =>
          row
            .map((c) => c?.text ?? ' ')
            .join('')
            .trimEnd(),
        )
        .join('\n')
        .trimEnd(),
    )
    .join('\n');
test('708 timeline checkpoints active windows, replaces future captions and clears discontinuities', () => {
  const t = new Cea708Timeline();
  t.update(packet([...define(), 65], 0), 0, 0, 2, 0, 0);
  assert.equal(screenText(t.events.at(-1)), 'A');
  t.update(packet([66], 2, 1), 0, 2, 4, 0, 0);
  assert.equal(screenText(t.events.at(-1)), 'AB');
  t.update(packet([67], 2, 1), 0, 2, 4, 0, 0, true);
  assert.equal(screenText(t.events.at(-1)), 'AC');
  t.update([], 0, 40, 42, 0, 40);
  assert.equal(screenText(t.events[0]), 'AC');
  assert.equal(t.events[0].checkpoint, true);
  t.update([], 0, 42, 44, 1, 40);
  assert.equal(screenText(t.events.at(-1)), '');
  t.update(packet([...define(), 68], 0), 0, 0, 2, 0, 0);
  assert.equal(screenText(t.events.at(-1)), 'D');
});
test('708 delay is replayed before its deadline and cancelled by a later packet', () => {
  const t = new Cea708Timeline();
  t.update(packet([...define(), 0x8d, 50, 65], 0), 0, 0, 2, 0, 0);
  assert.equal(screenText(t.events.at(-1)), '');
  t.update(packet([0x8e, 66], 2, 1), 0, 2, 4, 0, 0);
  assert.equal(screenText(t.events.at(-1)), 'AB');
  assert.equal(t.events.at(-1).time, 2);
  t.update([], 0, 4, 6, 0, 0);
  assert.ok(!t.events.some((e) => e.time === 5));
});

test('708 presentation-time overlap does not discard data owned by the previous segment', () => {
  const t = new Cea708Timeline();
  t.update(packet([...define(), 65], 2.01), 0, 0, 2, 0, 0);
  t.update(packet([66], 3, 1), 0, 2, 4, 0, 0);
  assert.equal(t.errors, 0);
  assert.equal(screenText(t.events.at(-1)), 'AB');
});
