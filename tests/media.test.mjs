import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeCue, trimCues } from '../src/subtitles/cues.mjs';
test('empty DVB display sets clear a cue and future cues do not draw early', () => {
  const first = { pts: 10, duration: 20, rects: [{}] },
    clear = { pts: 13, duration: 1, rects: [] };
  assert.equal(activeCue([first, clear], 9), null);
  assert.equal(activeCue([first, clear], 12), first);
  assert.equal(activeCue([first, clear], 13), clear);
  assert.equal(activeCue([first, clear], 15), null);
});
test('subtitle history is bounded and retains delayed current captions', () => {
  const cues = Array.from({ length: 500 }, (_, i) => ({ pts: i, duration: 2 }));
  const trimmed = trimCues(cues, 400);
  assert.ok(trimmed.length <= 200);
  assert.ok(trimmed.some((c) => c.pts === 400));
  assert.ok(trimmed.every((c) => c.pts + c.duration > 340));
});
