import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveBuffer, fragmentTiming } from '../src/engines/moq/buffer.mjs';
function box(type, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}
function fragment() {
  const hd = Buffer.alloc(12);
  hd.writeUInt32BE(0x20008);
  hd.writeUInt32BE(1, 4);
  hd.writeUInt32BE(250, 8);
  const dt = Buffer.alloc(12);
  dt[0] = 1;
  dt.writeBigUInt64BE(100000n, 4);
  const run = Buffer.alloc(8 + 4 * 4);
  run.writeUInt32BE(0x400);
  run.writeUInt32BE(4, 4);
  [0x02000000, 0x01010000, 0x02000000, 0x01010000].forEach((f, i) =>
    run.writeUInt32BE(f, 8 + i * 4),
  );
  return box(
    'moof',
    box(
      'traf',
      Buffer.concat([box('tfhd', hd), box('tfdt', dt), box('trun', run)]),
    ),
  );
}
test('parser measures two short GOPs inside one longer fragment instead of equating the two', () => {
  assert.deepEqual(fragmentTiming(fragment(), 1000), {
    start: 100,
    end: 101,
    duration: 1,
    keyframes: [100, 100.5],
  });
  assert.equal(fragmentTiming(fragment().subarray(0, 20), 1000), null);
});
function feed(b, count, duration, arrivalStep = duration, base = 0) {
  for (let i = 0; i < count; i++) {
    const start = base + i * duration;
    b.observe(
      { start, end: start + duration, duration, keyframes: [start] },
      (base + (i + 1) * arrivalStep) * 1000,
    );
  }
}
test('same player policy learns one-second and 2.4-second GOPs with no channel settings', () => {
  const short = new AdaptiveBuffer(),
    long = new AdaptiveBuffer();
  feed(short, 10, 1);
  feed(long, 10, 2.4);
  assert.ok(Math.abs(short.target - 2) < 0.001);
  assert.ok(Math.abs(long.target - 4.8) < 0.001);
});
test('jitter and underflow remain diagnostics and never inflate the two-GOP target', () => {
  const b = new AdaptiveBuffer();
  feed(b, 10, 2.4);
  const normal = b.target;
  b.observe({ start: 24, end: 26.4, duration: 2.4, keyframes: [24] }, 30000);
  assert.ok(b.jitter > 0);
  assert.ok(Math.abs(b.target - 4.8) < 1e-9);
  b.underflow(31000);
  b.underflow(31100);
  assert.equal(b.stalls, 1);
  assert.ok(Math.abs(b.target - normal) < 1e-9);
  const cached = new AdaptiveBuffer();
  feed(cached, 10, 1, 0.01);
  assert.equal(cached.jitter, 0);
  assert.equal(cached.target, 2);
});
test('GOP determines target independently of larger fragments and without a minimum clamp', () => {
  const b = new AdaptiveBuffer();
  b.observe(
    {
      start: 0,
      end: 3,
      duration: 3,
      keyframes: [0, 0.4, 0.8, 1.2, 1.6, 2, 2.4, 2.8],
    },
    3000,
  );
  assert.ok(Math.abs(b.target - 0.8) < 1e-9);
  assert.equal(b.fragment, 3);
});
test('target follows a shorter measured GOP without retaining the previous reserve', () => {
  const b = new AdaptiveBuffer();
  feed(b, 12, 2.4);
  feed(b, 20, 1, 1, 28.8);
  assert.ok(Math.abs(b.target - 2) < 1e-9);
  assert.equal(b.snapshot().mode, 'two-gop');
  for (let i = 0; i < 100; i++) b.underflow(1e6 + i * 11000);
  assert.ok(Math.abs(b.target - 2) < 1e-9);
});

function zeroFieldFragment(
  start = 0,
  allZero = false,
  missingDuration = false,
) {
  const hd = Buffer.alloc(12);
  hd.writeUInt32BE(missingDuration ? 0x20000 : 0x20008);
  hd.writeUInt32BE(1, 4);
  const dt = Buffer.alloc(12);
  dt[0] = 1;
  dt.writeBigUInt64BE(BigInt(start), 4);
  const durations = [
    0,
    ...Array(98).fill(allZero ? 0 : 256),
    allZero ? 0 : 512,
  ];
  const run = Buffer.alloc(12 + (missingDuration ? 0 : durations.length * 4));
  run.writeUInt32BE(missingDuration ? 4 : 0x104);
  run.writeUInt32BE(100, 4);
  run.writeUInt32BE(0x02000000, 8);
  if (!missingDuration)
    durations.forEach((d, i) => run.writeUInt32BE(d, 12 + 4 * i));
  return box(
    'moof',
    box(
      'traf',
      Buffer.concat([
        box('tfhd', missingDuration ? hd.subarray(0, 8) : hd),
        box('tfdt', dt),
        box('trun', run),
      ]),
    ),
  );
}
test('Originals: explicit zero-duration first field retains its sync flag and yields a two-second GOP', () => {
  const first = fragmentTiming(zeroFieldFragment(), 12800),
    second = fragmentTiming(zeroFieldFragment(25600), 12800);
  assert.equal(first.duration, 2);
  assert.equal(first.keyframes[0], 0);
  const b = new AdaptiveBuffer();
  b.observe(first, 2000);
  b.observe(second, 4000);
  assert.equal(b.gop, 2);
  assert.equal(b.target, 4);
});
test('all-zero timelines and missing duration defaults are not invented', () => {
  assert.equal(fragmentTiming(zeroFieldFragment(0, true), 12800), null);
  assert.equal(fragmentTiming(zeroFieldFragment(0, false, true), 12800), null);
});

test('cache-first mode keeps a four-second reserve independent of GOP and underflow', () => {
  const b = new AdaptiveBuffer({ targetSeconds: 4 });
  feed(b, 10, 3);
  assert.equal(b.target, 4);
  b.underflow(40000);
  assert.equal(b.target, 4);
  assert.equal(b.snapshot().mode, 'cache-reserve');
});
