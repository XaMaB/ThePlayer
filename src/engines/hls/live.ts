import { alignPlaylist, type Playlist } from './playlist';

const tailKey = (p: Playlist) => {
  const tail = p.segments.at(-1)!;
  return JSON.stringify([
    p.live,
    tail.sequence,
    tail.part,
    tail.discontinuity,
    tail.url,
    tail.range,
    tail.duration,
    tail.programDateTime,
  ]);
};
/** Track publisher progress separately from successful HTTP reloads. */
export class LiveProgress {
  private entries = new Map<string, { key: string; at: number }>();
  observe(p: Playlist, now: number): number {
    const key = tailKey(p),
      old = this.entries.get(p.url);
    if (!old || old.key !== key) {
      if (this.entries.size > 64) this.entries.clear();
      this.entries.set(p.url, { key, at: now });
      return 0;
    }
    return Math.max(0, now - old.at);
  }
  reset() {
    this.entries.clear();
  }
}
export function reconcileLive(
  next: Playlist,
  previous: Playlist,
  nextSequence: number,
): { playlist: Playlist; restart: boolean; reason: string } {
  // A backward sequence or changed resource identity indicates a new presentation.
  // Do not invent timestamps across an encoder restart or a lost live window.
  if (next.segments[0].sequence < previous.segments[0].sequence)
    return { playlist: next, restart: true, reason: 'media-sequence-reset' };
  try {
    const playlist = alignPlaylist(next, previous);
    if (playlist.segments[0].sequence > nextSequence)
      return { playlist: next, restart: true, reason: 'live-window-missed' };
    return { playlist, restart: false, reason: '' };
  } catch (error) {
    if (
      error instanceof Error &&
      /Live playlist changed|Live window lost synchronization/.test(
        error.message,
      )
    )
      return { playlist: next, restart: true, reason: 'timeline-changed' };
    throw error;
  }
}

/** Debug timeline decisions without exposing signed resource URLs or key material. */
export function timelineDifference(next: Playlist, previous: Playlist) {
  const window = (p: Playlist) => ({
    first: p.segments[0].sequence,
    last: p.segments.at(-1)!.sequence,
    discontinuity: p.segments[0].discontinuity,
    count: p.segments.length,
  });
  const segment = next.segments.find((s) =>
    previous.segments.some(
      (old) =>
        old.sequence === s.sequence && old.discontinuity === s.discontinuity,
    ),
  );
  const old =
    segment &&
    previous.segments.find(
      (s) =>
        s.sequence === segment.sequence &&
        s.discontinuity === segment.discontinuity,
    );
  const address = (a: string, b: string) => {
    const x = new URL(a),
      y = new URL(b);
    return {
      origin: x.origin !== y.origin,
      path: x.pathname !== y.pathname,
      query: x.search !== y.search,
    };
  };
  return {
    previous: window(previous),
    incoming: window(next),
    overlap:
      old && segment
        ? {
            sequence: segment.sequence,
            previousPart: old.part ?? null,
            incomingPart: segment.part ?? null,
            previousDuration: old.duration,
            incomingDuration: segment.duration,
            previousDateTime: old.programDateTime ?? null,
            incomingDateTime: segment.programDateTime ?? null,
            addressChanged: address(old.url, segment.url),
            rangeChanged:
              JSON.stringify(old.range) !== JSON.stringify(segment.range),
            initializationChanged:
              JSON.stringify(old.map) !== JSON.stringify(segment.map),
          }
        : null,
  };
}
