import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SubtitleCounters, activeCue } from '../src/subtitles/cues.mjs';
const caption = (png = 'a', pts = 10) => ({
  width: 1920,
  height: 1080,
  pts,
  duration: 2,
  rects: [{ x: 10, y: 900, w: 400, h: 60, png }],
});
test('received cached, future and clear events do not imply displayed subtitles', () => {
  const c = new SubtitleCounters(),
    events = [
      caption(),
      caption('future', 50),
      { ...caption('clear', 20), rects: [] },
    ];
  for (const e of events) c.receive();
  assert.equal(c.received, 3);
  assert.equal(c.displayed, 0);
  c.present(activeCue(events.slice(0, 1), 30), false);
  assert.equal(c.displayed, 0);
  c.present(events[0], true);
  assert.equal(c.displayed, 1);
  c.present(events[2], false);
  assert.equal(c.displayed, 1);
});
test('same caption refresh and canvas redraw count once; a later reappearance counts again', () => {
  const c = new SubtitleCounters();
  c.present(caption(), true);
  c.present(caption(), true);
  c.present(caption('a', 11), true);
  assert.equal(c.displayed, 1);
  c.present(caption('b'), true);
  assert.equal(c.displayed, 2);
  c.present(null, false);
  c.present(caption('b', 20), true);
  assert.equal(c.displayed, 3);
});
test('transparent images are not displayed captions; reconnect resets both counters', () => {
  const c = new SubtitleCounters();
  c.receive();
  c.present(caption(), false);
  assert.equal(c.displayed, 0);
  c.present(caption(), true);
  c.reset();
  assert.equal(c.received, 0);
  assert.equal(c.displayed, 0);
  c.present(caption(), true);
  assert.equal(c.displayed, 1);
});
