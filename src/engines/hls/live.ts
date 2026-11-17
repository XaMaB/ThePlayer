import { alignPlaylist, type Playlist } from './playlist';

const tailKey = (p: Playlist) => {
  const tail = p.segments.at(-1)!;
  return JSON.stringify([
    p.live,
    tail.sequence,
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
