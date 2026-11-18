import {
  skipAvailable,
  type Interstitial,
  type InterstitialAsset,
  type SkipControl,
} from './interstitials';

export interface AssetPlayer extends EventTarget {
  init(): Promise<void>;
  destroy(): Promise<void>;
}

/** Owns only the inserted presentation. The caller owns primary timeline restoration. */
export class InterstitialSession {
  private stopAsset?: () => void;
  private skipped = false;
  private elapsed = 0;
  private assetTime = 0;
  constructor(
    private video: HTMLVideoElement,
    readonly event: Interstitial,
    private skip: SkipControl,
    private signal: AbortSignal,
    private emit: (name: string, detail: unknown) => void,
  ) {}
  skipNow() {
    if (!skipAvailable(this.skip, this.elapsed + this.assetTime)) return false;
    this.skipped = true;
    this.stopAsset?.();
    return true;
  }
  async run(assets: InterstitialAsset[], create: (uri: string) => AssetPlayer) {
    let cancelled = false;
    for (let index = 0; index < assets.length; index++) {
      this.signal.throwIfAborted();
      if (this.skipped || this.elapsed >= (this.event.limit ?? Infinity)) break;
      const player = create(assets[index].uri);
      this.assetTime = 0;
      const listeners = new AbortController();
      let monitor: ReturnType<typeof setInterval> | undefined;
      let lastProgress = performance.now(),
        lastTime = -1;
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.stopAsset = finish;
      const update = () => {
        if (!this.video.seeking) this.assetTime = this.video.currentTime;
        const elapsed = this.elapsed + this.assetTime;
        this.emit('interstitialprogress', {
          id: this.event.range.id,
          index,
          elapsed,
          skippable: skipAvailable(this.skip, elapsed),
          label: this.skip.label,
        });
        if (elapsed >= (this.event.limit ?? Infinity)) finish();
      };
      const bad = (error: unknown) => {
        this.emit('interstitialwarning', {
          id: this.event.range.id,
          index,
          message: String(error),
        });
        if (this.event.uri) cancelled = true;
        finish();
      };
      player.addEventListener('error', (e) => bad((e as CustomEvent).detail), {
        signal: listeners.signal,
      });
      player.addEventListener(
        'autoplayblocked',
        () => this.emit('autoplayblocked', null),
        { signal: listeners.signal },
      );
      this.video.addEventListener('ended', finish, {
        signal: listeners.signal,
      });
      this.video.addEventListener('timeupdate', update, {
        signal: listeners.signal,
      });
      this.video.addEventListener(
        'seeking',
        () => {
          if (
            this.event.restrict.includes('SKIP') &&
            this.video.currentTime > this.assetTime + 0.1
          )
            this.video.currentTime = this.assetTime;
        },
        { signal: listeners.signal },
      );
      this.video.addEventListener(
        'ratechange',
        () => {
          if (
            this.event.restrict.includes('SKIP') &&
            this.video.playbackRate > 1
          )
            this.video.playbackRate = 1;
        },
        { signal: listeners.signal },
      );
      this.signal.addEventListener('abort', finish, { once: true });
      try {
        this.emit('interstitialasset', {
          id: this.event.range.id,
          index,
          ...assets[index],
        });
        await player.init();
        if (this.event.restrict.includes('SKIP') && this.video.playbackRate > 1)
          this.video.playbackRate = 1;
        monitor = setInterval(() => {
          update();
          if (this.video.paused || this.video.currentTime !== lastTime) {
            lastTime = this.video.currentTime;
            lastProgress = performance.now();
          } else if (performance.now() - lastProgress > 15000) {
            bad(new Error('Interstitial playback stopped advancing'));
          }
        }, 50);
        await done;
        this.elapsed += Math.min(
          this.video.currentTime,
          Math.max(0, (this.event.limit ?? Infinity) - this.elapsed),
        );
      } catch (error) {
        this.signal.throwIfAborted();
        bad(error);
      } finally {
        clearInterval(monitor);
        listeners.abort();
        this.signal.removeEventListener('abort', finish);
        this.stopAsset = undefined;
        await player.destroy();
      }
      if (cancelled) break;
    }
    this.signal.throwIfAborted();
    return { played: this.elapsed, cancelled, skipped: this.skipped };
  }
}
