/** Local playback metrics; exporting them is an application decision. */
export class PlaybackMetrics {
  private started = performance.now();
  private startupMs: number | null = null;
  private stalledAt?: number;
  private stalls = 0;
  private stalledMs = 0;
  constructor(
    private video: HTMLVideoElement,
    signal: AbortSignal,
  ) {
    const stop = () => {
      if (this.stalledAt !== undefined) {
        this.stalledMs += performance.now() - this.stalledAt;
        this.stalledAt = undefined;
      }
    };
    video.addEventListener(
      'loadeddata',
      () => {
        this.startupMs ??= performance.now() - this.started;
      },
      { signal },
    );
    video.addEventListener(
      'waiting',
      () => {
        if (
          this.startupMs === null ||
          video.paused ||
          video.seeking ||
          this.stalledAt !== undefined
        )
          return;
        this.stalls++;
        this.stalledAt = performance.now();
      },
      { signal },
    );
    for (const name of ['playing', 'pause', 'seeking', 'ended'])
      video.addEventListener(name, stop, { signal });
    signal.addEventListener('abort', stop, { once: true });
  }
  snapshot() {
    const quality = this.video.getVideoPlaybackQuality?.();
    return {
      startupMs: this.startupMs,
      rebufferCount: this.stalls,
      rebufferMs:
        this.stalledMs +
        (this.stalledAt === undefined ? 0 : performance.now() - this.stalledAt),
      totalFrames: quality?.totalVideoFrames ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? null,
    };
  }
}
