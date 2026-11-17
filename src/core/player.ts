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
  readonly subtitleTracks: any[];
  readonly selectedAudioTrack: string;
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
) => PlaybackEngine;
export type EngineRegistry = Readonly<Record<string, EngineFactory>>;

const events = [
  'statechange',
  'catalog',
  'error',
  'autoplayblocked',
  'audiochange',
  'subtitletracks',
  'subtitlechange',
  'caption',
  'captionwarning',
];

/** No transport imports: applications can supply only the engines they need. */
export class PlayerCore extends EventTarget {
  private engine?: PlaybackEngine;
  private listeners?: AbortController;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

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
      const engine = factory(this.video, source);
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
    return this.engine?.diagnostics;
  }
  get catalog() {
    return this.engine?.catalog;
  }
  get targetBuffer() {
    return this.engine?.targetBuffer ?? 4;
  }
  get audioTracks() {
    return this.engine?.audioTracks ?? [];
  }
  get subtitleTracks() {
    return this.engine?.subtitleTracks ?? [];
  }
  get selectedAudioTrack() {
    return this.engine?.selectedAudioTrack ?? '';
  }
  subtitleHistory(name: string) {
    return this.engine?.subtitleHistory?.(name) ?? [];
  }
  async play() {
    await this.engine?.play();
  }
  async selectAudioTrack(name: string) {
    if (!this.engine) throw new Error('No source loaded');
    await this.engine.selectAudioTrack(name);
  }
  selectSubtitleTrack(name: string) {
    if (!this.engine) throw new Error('No source loaded');
    this.engine.selectSubtitleTrack(name);
  }
}
