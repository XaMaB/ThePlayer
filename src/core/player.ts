import type { Thumbnail } from './thumbnail';
import type { TimelineMarker } from './timeline';
export type { TimelineMarker } from './timeline';
/** Common lifecycle. Engines own their transport, buffering and media pipeline. */
export interface PlaybackSource {
  protocol?: string;
  [key: string]: unknown;
}

export interface PlaybackEngine extends EventTarget {
  readonly protocol: string;
  readonly stack: string;
  readonly source: PlaybackSource;
  readonly diagnostics: any;
  readonly catalog: any;
  readonly targetBuffer: number;
  readonly audioTracks: any[];
  readonly videoTracks?: any[];
  readonly selectedVideoTrack?: string;
  selectVideoTrack?(name: string): Promise<void>;
  readonly subtitleTracks: any[];
  readonly selectedAudioTrack: string;
  readonly selectedSubtitleTrack?: string;
  /** An inserted presentation; null means transition, undefined means primary. */
  readonly presentation?: PlaybackEngine | null;
  readonly isLive?: boolean;
  readonly mediaMode?: 'video' | 'audio';
  readonly availableMediaModes?: ('video' | 'audio')[];
  readonly qualityLevels?: any[];
  readonly selectedQuality?: number;
  readonly currentQuality?: number;
  readonly autoQuality?: boolean;
  readonly timelineMarkers?: TimelineMarker[];
  selectQuality?(index: number): Promise<void>;
  seekToLive?(): void;
  skipInterstitial?(): boolean;
  getThumbnail?(time: number): Promise<Thumbnail | undefined>;
  init(): Promise<void>;
  play(): Promise<void>;
  destroy(): Promise<void>;
  selectAudioTrack(name: string): Promise<void>;
  selectSubtitleTrack(name: string): void;
  subtitleHistory?(name: string): any[];
}

export type EngineFactory = (
  video: HTMLVideoElement,
  source: any,
) => PlaybackEngine | Promise<PlaybackEngine>;
export type EngineRegistry = Readonly<Record<string, EngineFactory>>;

const events = [
  'statechange',
  'streamchange',
  'catalog',
  'error',
  'autoplayblocked',
  'audiochange',
  'videochange',
  'videotracks',
  'qualitylevels',
  'qualitychange',
  'subtitletracks',
  'subtitlechange',
  'subtitlemetrics',
  'caption',
  'captionwarning',
  'metadata',
  'metadatawarning',
  'pathwaychange',
  'daterange',
  'daterangeremove',
  'daterangeenter',
  'daterangeexit',
  'daterangecue',
  'interstitialstart',
  'interstitialasset',
  'interstitialprogress',
  'interstitialend',
  'interstitialwarning',
];

/** No transport imports: applications can supply only the engines they need. */
export class PlayerCore extends EventTarget {
  private engine?: PlaybackEngine;
  private listeners?: AbortController;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private get activePresentation() {
    return this.engine?.presentation === undefined
      ? this.engine
      : (this.engine.presentation ?? undefined);
  }

  constructor(
    readonly video: HTMLVideoElement,
    private readonly engines: EngineRegistry,
  ) {
    super();
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.queue.then(action);
    this.queue = next.catch(() => {});
    return next;
  }

  load(source: PlaybackSource): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('ThePlayer has been destroyed');
      const protocol = source.protocol ?? 'moq';
      const factory = this.engines[protocol];
      if (!factory)
        throw new Error(`No playback engine registered for ${protocol}`);
      await this.release();
      const engine = await factory(this.video, source);
      if (this.closed) {
        await engine.destroy();
        throw new Error('ThePlayer has been destroyed');
      }
      this.engine = engine;
      this.listeners = new AbortController();
      for (const name of events) {
        engine.addEventListener(
          name,
          (event) => {
            this.dispatchEvent(
              new CustomEvent(name, { detail: (event as CustomEvent).detail }),
            );
          },
          { signal: this.listeners.signal },
        );
      }
      try {
        await engine.init();
      } catch (error) {
        await this.release();
        throw error;
      }
    });
  }

  private async release() {
    this.listeners?.abort();
    this.listeners = undefined;
    const old = this.engine;
    this.engine = undefined;
    await old?.destroy();
  }

  destroy(): Promise<void> {
    this.closed = true;
    // Stop pending network waits immediately, then finish the serialized teardown.
    const stopping = this.engine?.destroy();
    return this.enqueue(async () => {
      await stopping;
      await this.release();
    });
  }

  get isLive() {
    return this.engine?.isLive ?? this.engine?.protocol === 'moq';
  }
  getThumbnail(time: number): Promise<Thumbnail | undefined> {
    return this.engine?.getThumbnail?.(time) ?? Promise.resolve(undefined);
  }
  get timelineMarkers(): TimelineMarker[] {
    return this.engine?.timelineMarkers ?? [];
  }
  skipInterstitial() {
    return this.engine?.skipInterstitial?.() ?? false;
  }
  seekToLive() {
    if (!this.isLive) return;
    if (this.engine?.seekToLive) {
      this.engine.seekToLive();
      return;
    }
    const b = this.video.buffered;
    if (b.length)
      this.video.currentTime = Math.max(
        b.start(b.length - 1),
        b.end(b.length - 1) - this.targetBuffer,
      );
    void this.play();
  }
  get protocol() {
    return this.engine?.protocol ?? '';
  }
  get stack() {
    return this.engine?.stack ?? '';
  }
  get source() {
    return this.engine?.source;
  }
  get diagnostics() {
    const active = this.activePresentation;
    return active && active !== this.engine
      ? {
          ...active.diagnostics,
          interstitial: this.engine?.diagnostics?.interstitial,
        }
      : this.engine?.diagnostics;
  }
  get catalog() {
    return this.activePresentation?.catalog;
  }
  get targetBuffer() {
    return this.activePresentation?.targetBuffer ?? 4;
  }
  get videoTracks() {
    return this.activePresentation?.videoTracks ?? [];
  }
  get selectedVideoTrack() {
    return this.activePresentation?.selectedVideoTrack ?? '';
  }
  async selectVideoTrack(name: string) {
    const engine = this.activePresentation;
    if (!engine?.selectVideoTrack)
      throw new Error('Video rendition selection is unavailable');
    await engine.selectVideoTrack(name);
  }
  get audioTracks() {
    return this.activePresentation?.audioTracks ?? [];
  }
  get subtitleTracks() {
    return this.activePresentation?.subtitleTracks ?? [];
  }
  get selectedAudioTrack() {
    return this.activePresentation?.selectedAudioTrack ?? '';
  }
  get selectedSubtitleTrack() {
    return this.activePresentation?.selectedSubtitleTrack ?? '';
  }
  get mediaMode() {
    return this.activePresentation?.mediaMode ?? 'video';
  }
  get availableMediaModes() {
    return this.engine?.presentation === undefined
      ? (this.engine?.availableMediaModes ?? [])
      : [];
  }
  async selectMediaMode(media: 'video' | 'audio') {
    if (this.protocol !== 'hls' || !this.availableMediaModes.includes(media))
      throw new Error('Media mode is unavailable');
    if (this.mediaMode === media) return;
    await this.load({
      ...this.source,
      media,
      quality: 'auto',
      startTime: this.isLive ? undefined : this.video.currentTime,
      autoplay: !this.video.paused,
    });
  }
  get qualityLevels() {
    return this.activePresentation?.qualityLevels ?? [];
  }
  get selectedQuality() {
    return this.activePresentation?.selectedQuality ?? -1;
  }
  get currentQuality() {
    return this.activePresentation?.currentQuality ?? this.selectedQuality;
  }
  get autoQuality() {
    return this.activePresentation?.autoQuality ?? false;
  }
  async selectQuality(index: number) {
    const engine = this.activePresentation;
    if (!engine?.selectQuality)
      throw new Error('Quality selection is not supported');
    await engine.selectQuality(index);
  }
  subtitleHistory(name: string) {
    return this.activePresentation?.subtitleHistory?.(name) ?? [];
  }
  async play() {
    await this.engine?.play();
  }
  async selectAudioTrack(name: string) {
    const engine = this.activePresentation;
    if (!engine) throw new Error('No active presentation');
    await engine.selectAudioTrack(name);
  }
  selectSubtitleTrack(name: string) {
    const engine = this.activePresentation;
    if (!engine) throw new Error('No active presentation');
    engine.selectSubtitleTrack(name);
  }
}
