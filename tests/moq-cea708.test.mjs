import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Cea708Decoder,
  Cea708Service,
  init,
  track,
  initialization,
  define,
  packet,
  media,
  plain,
} from './helpers/moq-caption-fixture.mjs';
import { SubtitleCounters, activeCue } from '../src/subtitles/cues.mjs';
const decode = (commands, options = {}) =>
  new Cea708Decoder(init, options).push(media(packet(commands)));
test('MoQ P16 Cyrillic, Latin Extended and control-range operands remain text', () => {
  assert.equal(
    decode([...define(), 0x18, 4, 0x11, 0x18, 1, 0x7c, 0x18, 1, 0x42]).at(-1)
      .cue.text,
    'Бżł',
  );
  assert.equal(
    decode([...define(), 65, 0x18, 1, 0x88, 0x18, 0, 32, 66]).at(-1).cue.text,
    'Aƈ B',
  );
  assert.equal(
    decode([...define(), 0x18, 0xb0, 0xa1], {
      SERVICE1: { encoding: 'euc-kr' },
    }).at(-1).cue.text,
    '가',
  );
  assert.equal(decode([...define(), 0x18, 0xd8, 0]).at(-1).cue.text, '\ufffd');
  assert.throws(
    () => new Cea708Decoder(init, { SERVICE1: { encoding: 'unknown' } }),
    /encoding/,
  );
});
test('MoQ packets span fragments and preserve absolute PTS with composition offsets', () => {
  const d = new Cea708Decoder(init),
    pairs = packet([...define(), 65, 0x18, 4, 0x16]);
  assert.deepEqual(d.push(media(pairs.slice(0, 3), 100, 0.04, 0.08)), []);
  const events = d.push(media(pairs.slice(3), 100.04, 0.04, 0.08));
  assert.equal(events.at(-1).cue.text, 'AЖ');
  assert.equal(events.at(-1).cue.pts, 100.08);
  assert.equal(d.errors, 0);
});
test('MoQ services, metadata, hide/clear and duplicate fragments preserve stable events', () => {
  const d = new Cea708Decoder(init, {
    SERVICE1: { language: 'bg', label: 'Bulgarian' },
  });
  const a = media(packet([...define(), 65], 1, 0), 1);
  const first = d.push(a);
  assert.equal(first.at(-1).track.label, 'Bulgarian');
  assert.equal(first.at(-1).track.language, 'bg');
  assert.deepEqual(d.push(a), []);
  d.push(media(packet([...define(), 66], 63, 1), 2));
  const clear = d.push(media(packet([0x8a, 1], 1, 2), 3));
  assert.equal(clear.at(-1).cue.text, '');
  assert.equal(clear.at(-1).cue.pts, 3);
  assert.equal(d.history('cea708-63').at(-1).text, 'B');
  assert.equal(d.tracks.size, 2);
  assert.equal(first.at(-1).cue.text, 'A', 'old snapshots immutable');
});
test('MoQ truncated P16 cannot consume another service, and malformed media is isolated', () => {
  const d = new Cea708Decoder(init);
  d.push(media(packet([...define(), 65, 0x18, 4], 1, 0), 1));
  d.push(media(packet([...define(), 66], 2, 1), 2));
  assert.equal(d.history('cea708-1').at(-1).text, 'A');
  assert.equal(d.history('cea708-2').at(-1).text, 'B');
  assert.throws(
    () => d.push(Uint8Array.of(0, 0, 0, 12, 109, 111, 111, 102)),
    /MP4/,
  );
  d.push(media(packet([0x16], 1, 2), 3));
  assert.equal(d.history('cea708-1').at(-1).text, 'AЖ');
});
test('MoQ SPL, 42 columns, anchors and justification match the canvas cue contract', () => {
  const d = new Cea708Decoder(init);
  d.push(media(packet([...define(), 65, 66, 67, 0x92, 0, 1, 90]), 1));
  d.push(media(packet([0x92, 1, 3, 88], 1, 1), 2));
  const w = d.history('cea708-1').at(-1).windows[0];
  assert.deepEqual(w.rows, ['AZC', '   X']);
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
  const before = structuredClone(w);
  d.push(media(packet([0x97, 0xc0, 0, 2, 0], 1, 2), 3));
  assert.equal(d.history('cea708-1').at(-1).windows[0].attributes.justify, 2);
  assert.deepEqual(w, before);
  const s = new Cea708Service(1);
  s.push(Uint8Array.from(define()), 0);
  s.push(Uint8Array.from(Array(30).fill(65)), 0);
  s.push(Uint8Array.from([0x92, 0, 30, ...Array(12).fill(66)]), 1);
  assert.equal(plain(s), 'A'.repeat(30) + 'B'.repeat(12));
});
test('MoQ delay advances on empty caption fragments and history stays bounded', () => {
  const d = new Cea708Decoder(init);
  d.push(media(packet([...define(), 65, 0x8d, 20, 66]), 1, 0.5));
  assert.equal(d.history('cea708-1').at(-1).text, 'A');
  d.push(media([], 2, 2));
  assert.equal(d.history('cea708-1').at(-1).text, 'AB');
  assert.equal(d.history('cea708-1').at(-1).pts, 3);
  for (let i = 0; i < 230; i++)
    d.push(
      media(
        packet([0x80, 0x88, 1, 0x92, 0, 0, 65 + (i % 26)], 1, (i + 1) % 4),
        4 + i,
      ),
      4 + i,
    );
  assert.ok(d.history('cea708-1').length <= 200);
  assert.ok(d.history('cea708-1').at(-1).pts > 200);
});
test('MoQ shared parser reads HEVC SEI and ignores CEA-608 packets', () => {
  const hvcc = new Uint8Array(23);
  hvcc[0] = 1;
  hvcc[1] = 2;
  hvcc[12] = 123;
  hvcc[21] = 3;
  const hevc = { ...track, hvcc, codec: 'hvc1.2.0.L123' };
  const d = new Cea708Decoder(initialization([hevc]));
  assert.equal(
    d.push(media(packet([...define(), 65]), 1, 1, 0, hevc)).at(-1).cue.text,
    'A',
  );
  assert.deepEqual(
    new Cea708Decoder(init).push(media([{ type: 0, first: 65, second: 66 }])),
    [],
  );
});
test('CEA text appearance counters honor repetition and clears', () => {
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
test('MoQ replay retracts superseded delayed displays and resets a restarted media clock', () => {
  const d = new Cea708Decoder(init);
  d.push(media(packet([...define(), 65, 0x8d, 20, 66]), 1, 4));
  assert.equal(d.history('cea708-1').at(-1).text, 'AB');
  const replacement = d.push(
    media(packet([0x8f, ...define(), 67], 1, 1), 2, 4),
  );
  assert.equal(replacement[0].replaceFrom, 2);
  assert.equal(replacement.at(-1).cue.text, 'C');
  assert.ok(!d.history('cea708-1').some((c) => c.text === 'AB'));
  const restarted = d.push(media(packet([...define(), 68]), 0, 1));
  assert.equal(restarted[0].replaceFrom, 0);
  assert.equal(restarted.at(-1).cue.text, 'D');
  assert.equal(d.history('cea708-1').at(-1).pts, 0);
});
test('MoQ sequence loss clears an old display before the next valid definition', () => {
  const d = new Cea708Decoder(init);
  d.push(media(packet([...define(), 65]), 1));
  const events = d.push(media(packet([], 1, 2), 2));
  assert.ok(events.some((e) => e.cue.text === ''));
  assert.ok(d.errors > 0);
  assert.equal(
    d.push(media(packet([...define(), 66], 1, 3), 3)).at(-1).cue.text,
    'B',
  );
});

// A replay can begin with an actual display rather than a checkpoint. Keeping
// old cues up to the incoming fragment start would duplicate every replayed cue.
test('MoQ successive fragments retain one snapshot per timestamp across replay and pruning', () => {
  const decoder = new Cea708Decoder(init);
  decoder.push(media(packet([...define(), 65]), 1));
  for (let i = 2; i < 80; i++) {
    assert.deepEqual(decoder.push(media([], i), i), []);
    const history = decoder.history('cea708-1');
    assert.equal(new Set(history.map((c) => c.pts)).size, history.length);
    assert.equal(history.filter((c) => c.text === 'A').length, 1);
  }
});
