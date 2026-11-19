import type { PlaybackSource } from '../core/player';
export interface Chapter {
  title: string;
  start: number;
}
export interface QueueItem {
  id: string;
  title: string;
  source: PlaybackSource;
  chapters?: readonly Chapter[];
}
export interface QueuePlayer {
  readonly video: HTMLVideoElement;
  readonly isLive: boolean;
  readonly diagnostics?: any;
  load(source: PlaybackSource): Promise<void>;
  play(): Promise<void>;
}
/** Application-owned queue. Does not silently replace the application's player. */
export class PlaybackQueue extends EventTarget {
  readonly items: readonly QueueItem[];
  private current = -1;
  private busy = false;
  private closed = false;
  private generation = 0;
  private readonly ended = () => {
    const player = this.getPlayer();
    if (
      !this.closed &&
      !this.busy &&
      this.autoAdvance &&
      !player?.isLive &&
      !player?.diagnostics?.interstitial?.active &&
      this.hasNext
    )
      void this.select(this.current + 1).catch((error) =>
        this.dispatchEvent(new CustomEvent('error', { detail: error })),
      );
  };
  private video: HTMLVideoElement;
  constructor(
    private getPlayer: () => QueuePlayer,
    items: readonly QueueItem[],
    readonly autoAdvance = true,
  ) {
    super();
    const ids = new Set<string>();
    for (const item of items) {
      if (!item.id || ids.has(item.id))
        throw new Error('Queue item IDs must be nonempty and unique');
      ids.add(item.id);
    }
    this.items = Object.freeze(
      items.map((item) =>
        Object.freeze({
          ...item,
          source: { ...item.source },
          chapters: item.chapters?.map((chapter) => ({ ...chapter })),
        }),
      ),
    );
    this.video = getPlayer().video;
    this.video.addEventListener('ended', this.ended);
  }
  get index() {
    return this.current;
  }
  get loading() {
    return this.busy;
  }
  get hasNext() {
    return this.current >= 0 && this.current + 1 < this.items.length;
  }
  get hasPrevious() {
    return this.current > 0;
  }
  async select(index: number): Promise<void> {
    if (this.closed) throw new Error('Queue has been destroyed');
    if (this.busy) throw new Error('A queue item is already loading');
    if (!Number.isInteger(index) || index < 0 || index >= this.items.length)
      throw new RangeError('Invalid queue index');
    const player = this.getPlayer();
    if (player.video !== this.video)
      throw new Error('Queue player must retain the same video element');
    const generation = this.generation;
    this.busy = true;
    this.dispatchEvent(new Event('change'));
    try {
      await player.load(this.items[index].source);
      if (this.closed || generation !== this.generation) return;
      this.current = index;
      await player.play();
    } catch (error) {
      // A failed load may have replaced the old engine: do not auto-advance it.
      if (generation === this.generation) this.current = -1;
      throw error;
    } finally {
      this.busy = false;
      this.dispatchEvent(new Event('change'));
    }
  }
  async next() {
    if (this.hasNext) await this.select(this.current + 1);
  }
  async previous() {
    if (this.hasPrevious) await this.select(this.current - 1);
  }
  /** Call when the application loads a source outside the queue. */
  reset() {
    this.generation++;
    this.current = -1;
    this.dispatchEvent(new Event('change'));
  }
  destroy() {
    this.generation++;
    this.closed = true;
    this.video.removeEventListener('ended', this.ended);
  }
}

export function chaptersFor(
  video: HTMLVideoElement,
  supplied?: readonly Chapter[],
): Chapter[] {
  const entries =
    supplied ??
    Array.from(video.textTracks)
      .filter((track) => track.kind === 'chapters')
      .flatMap((track) =>
        Array.from(track.cues ?? []).map((cue) => ({
          start: cue.startTime,
          title: (cue as VTTCue).text,
        })),
      );
  return entries
    .filter(
      (c) =>
        Number.isFinite(c.start) && c.start >= 0 && typeof c.title === 'string',
    )
    .map((c) => ({ ...c }))
    .sort((a, b) => a.start - b.start);
}
