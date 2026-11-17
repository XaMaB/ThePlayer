export function activeCue(cues, time) {
  let active = null;
  for (const cue of cues) {
    if (cue.pts > time) break;
    // A new display set (including empty clear) replaces the previous one.
    active = cue;
  }
  return active && time < active.pts + active.duration ? active : null;
}
export function trimCues(cues, time) {
  const recent = cues.filter(
    (c) => c.pts + c.duration > time - 60 && c.pts < time + 120,
  );
  return recent.slice(-200);
}

// Counts transport events separately from changes to the visible subtitle layer.
// Timing-only refreshes and canvas redraws do not create a new displayed caption.
export class SubtitleCounters {
  received = 0;
  displayed = 0;
  constructor() {
    this.reset();
  }
  reset() {
    this.received = 0;
    this.displayed = 0;
    this.visibleSignature = null;
  }
  receive() {
    this.received++;
  }
  present(cue, hasVisiblePixels) {
    if (!cue || !hasVisiblePixels) {
      this.visibleSignature = null;
      return;
    }
    const signature = JSON.stringify([
      cue.width,
      cue.height,
      cue.text ?? null,
      cue.windows ?? null,
      cue.rects.map((r) => [r.x, r.y, r.w, r.h, r.png]),
    ]);
    if (signature !== this.visibleSignature) this.displayed++;
    this.visibleSignature = signature;
  }
}
