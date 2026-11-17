import { Cea708Decoder } from '../../subtitles/cea708/decoder.mjs';
import * as Moq from '@moq/net';
import { cachedStartPlan } from './startup.mjs';
import { AdaptiveBuffer, fragmentTiming } from './buffer.mjs';

/** Endpoint supplied by the embedding application. No dashboard/status API dependency. */
export interface PlayerSource {
  [key: string]: unknown;
  protocol?: 'moq';
  relayUrl: string;
  namespace: string;
  catalogTrack?: string;
  certificateHash?: string;
  versions?: string[];
  captionServices?: Record<
    string,
    { language?: string; label?: string; encoding?: string }
  >;
}
export class MoqEngine extends EventTarget {
  readonly protocol = 'moq' as const;
  readonly stack = 'moq-dev/moq';
  readonly diagnostics = {
    objects: 0,
    bytes: 0,
    version: 'moq-lite-06',
    state: 'idle',
    startup: {
      mode: 'cache-first',
      firstFrameMs: null as number | null,
      reserveReadyMs: null as number | null,
      initialBuffer: 0,
    },
    buffer: {} as any,
    media: [] as any[],
  };
  private origin: any;
  private connection: any;
  private broadcast: any;
  private active: any;
  private media?: MediaSource;
  private url?: string;
  private timer?: ReturnType<typeof setInterval>;
  private abort = new AbortController();
  private subscriptions = new Set<any>();
  private adaptive = new AdaptiveBuffer({ targetSeconds: 4 });
  private rebuffering = false;
  get targetBuffer() {
    return this.adaptive.target;
  }
  private initAt = 0;
  private coldStart = false;
  private started = false;
  private lastProgress = Date.now();
  private lastTime = 0;
  catalog: any;
  private captions?: Cea708Decoder;
  get subtitleTracks() {
    return [
      ...(this.catalog?.subtitles ?? []),
      ...(this.captions?.tracks.values() ?? []),
    ];
  }
  subtitleHistory(name: string) {
    return this.captions?.history(name) ?? [];
  }
  private selectedSubtitleTrack = '';
  private subtitleGeneration = 0;
  private subtitleSubscription?: ReturnType<MoqEngine['subscribe']>;
  selectSubtitleTrack(name: string) {
    const track = this.subtitleTracks.find((track: any) => track.name === name);
    if (name && !track) throw new Error('Unknown subtitle track');
    const generation = ++this.subtitleGeneration;
    this.subtitleSubscription?.close();
    this.subtitleSubscription = undefined;
    this.selectedSubtitleTrack = name;
    this.emit('subtitlechange', track ?? null);
    if (!track) return;
    if (track.inband) {
      for (const cue of this.subtitleHistory(name))
        this.emit('caption', { track, cue });
      return;
    }
    const sub = this.subscribe(name);
    this.subtitleSubscription = sub;
    void (async () => {
      try {
        while (
          generation === this.subtitleGeneration &&
          !this.abort.signal.aborted
        ) {
          const frame = await sub.reader.readFrame();
          if (!frame || generation !== this.subtitleGeneration) break;
          if (frame.payload.byteLength > 16 * 1024 * 1024)
            throw new Error('Subtitle object exceeds limit');
          const cue = JSON.parse(new TextDecoder().decode(frame.payload));
          if (
            Number.isFinite(cue.pts) &&
            Number.isFinite(cue.duration) &&
            Array.isArray(cue.rects)
          )
            this.emit('caption', { track, cue });
        }
      } catch (error) {
        if (
          generation === this.subtitleGeneration &&
          !this.abort.signal.aborted
        )
          this.emit('captionwarning', error);
      } finally {
        sub.close();
      }
    })();
  }
  selectedAudioTrack = '';
  get audioTracks() {
    return this.catalog?.tracks?.filter((t: any) => t.role === 'audio') ?? [];
  }
  private audioBuffer?: SourceBuffer;
  private audioSession: any;
  private switchingAudio = false;
  private startAudio(t: any, sb: SourceBuffer, start: bigint) {
    const session: any = { cancelled: false, close: () => {}, done: null };
    this.audioSession = session;
    session.done = this.receive(t.name, sb, 100, 0, start, session).catch(
      (e) => {
        if (!session.cancelled) this.fail(e);
      },
    );
  }
  /** Switch only the audio subscription; retain the video timeline and connection. */
  async selectAudioTrack(name: string) {
    if (name === this.selectedAudioTrack) return;
    if (this.switchingAudio)
      throw new Error('An audio change is already in progress');
    const t = this.audioTracks.find((t: any) => t.name === name),
      sb = this.audioBuffer;
    if (!t || !sb || !this.audioSession)
      throw new Error('Audio track is not ready');
    const mime = `audio/mp4; codecs="${t.codec}"`;
    if (!MediaSource.isTypeSupported(mime))
      throw new Error(`Unsupported audio codec: ${t.codec}`);
    const data = this.catalog.initDataList.find(
      (d: any) => d.id === t.initRef,
    )?.data;
    if (typeof data !== 'string')
      throw new Error('Missing audio initialization');
    this.switchingAudio = true;
    const resume = !this.video.paused || this.rebuffering;
    let peek: any;
    try {
      // Resolve the new track before stopping the old one.
      peek = this.subscribe(name, 100, undefined, true, 30000);
      const frame = await this.wait<
        { payload: Uint8Array; group: bigint } | undefined
      >(peek.reader.readFrame());
      if (!frame) throw new Error('Audio track has no media');
      const timing = fragmentTiming(frame.payload, Number(t.timescale));
      if (!timing || timing.duration <= 0)
        throw new Error('Invalid audio timestamps');
      const back = Math.min(
        512,
        Math.max(
          0,
          Math.ceil(
            (timing.end - this.video.currentTime + 1) / timing.duration,
          ) - 1,
        ),
      );
      const start =
        frame.group > BigInt(back) ? frame.group - BigInt(back) : 1n;
      this.video.pause();
      const old = this.audioSession;
      old.cancelled = true;
      old.close();
      await this.wait(old.done);
      if (this.abort.signal.aborted) return;
      await this.wait(
        new Promise<void>((resolve, reject) => {
          sb.addEventListener('updateend', () => resolve(), { once: true });
          try {
            sb.remove(0, Infinity);
          } catch (e) {
            reject(e);
          }
        }),
      );
      sb.changeType(mime);
      await this.append(
        sb,
        Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      );
      // Release the latest-only cursor before requesting history: overlapping
      // latest-only and history cursors must not share a pending read.
      peek.close();
      peek = null;
      this.selectedAudioTrack = name;
      this.startAudio(t, sb, start);
      this.rebuffering = resume;
      if (resume) this.state('buffering');
      this.emit('audiochange', t);
    } catch (e) {
      this.fail(e);
      throw e;
    } finally {
      peek?.close();
      this.switchingAudio = false;
    }
  }
  constructor(
    readonly video: HTMLVideoElement,
    readonly source: PlayerSource,
  ) {
    super();
    video.addEventListener(
      'waiting',
      () => {
        if (
          !this.started ||
          video.paused ||
          video.seeking ||
          this.rebuffering ||
          this.abort.signal.aborted
        )
          return;
        this.adaptive.underflow(performance.now());
        this.rebuffering = true;
        video.pause();
        video.playbackRate = 1;
        this.state('buffering');
      },
      { signal: this.abort.signal },
    );
  }
  private emit(name: string, detail: any) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  private state(value: string) {
    this.diagnostics.state = value;
    this.emit('statechange', value);
  }
  private fail(e: any) {
    if (!this.abort.signal.aborted) {
      this.state('error');
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
    }
  }
  private async wait<T>(promise: Promise<T>, ms = 15000): Promise<T> {
    let timer: any;
    let stop: any;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('MoQ operation timed out')),
            ms,
          );
          stop = () => reject(new DOMException('Player closed', 'AbortError'));
          this.abort.signal.addEventListener('abort', stop, { once: true });
          if (this.abort.signal.aborted) stop();
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', stop);
    }
  }
  async init() {
    this.initAt = performance.now();
    this.video.requestVideoFrameCallback(() => {
      if (this.abort.signal.aborted) return;
      this.diagnostics.startup.firstFrameMs = performance.now() - this.initAt;
    });
    this.state('connecting');
    this.origin = new Moq.Origin.Producer();
    const connection = await this.wait(
      Moq.Connection.connect({
        url: new URL(this.source.relayUrl),
        consume: this.origin,
        versions: this.source.versions ?? ['moq-lite-06'],
        websocket: { enabled: false },
        webtransport: this.source.certificateHash
          ? {
              serverCertificateHashes: [{ value: this.source.certificateHash }],
            }
          : undefined,
      }),
    );
    if (this.abort.signal.aborted) {
      await connection.close();
      return;
    }
    this.connection = connection;
    void this.connection.closed.then((e: any) => {
      if (!this.abort.signal.aborted)
        this.fail(e ?? new Error('Relay connection closed'));
    });
    this.broadcast = this.origin.request(Moq.Path.from(this.source.namespace));
    await this.wait(
      (async () => {
        while (!(this.active = this.broadcast.active.peek()))
          await this.broadcast.active.changed();
      })(),
    );
    const catalogSub = this.subscribe(
      this.source.catalogTrack ?? 'catalog',
      64,
      undefined,
      true,
    );
    try {
      const first = await this.wait<
        { payload: Uint8Array; group: bigint } | undefined
      >(catalogSub.reader.readFrame());
      if (!first) throw new Error('Catalog ended');
      this.catalog = JSON.parse(new TextDecoder().decode(first.payload));
    } finally {
      catalogSub.close();
    }
    if (
      this.catalog.profile !== 'origin-cmaf-v1' ||
      !Array.isArray(this.catalog.tracks) ||
      !Array.isArray(this.catalog.initDataList)
    )
      throw new Error('Unsupported catalog: expected origin-cmaf-v1');
    this.selectedAudioTrack =
      (this.audioTracks.find((t: any) => t.default) ?? this.audioTracks[0])
        ?.name ?? '';
    this.emit('catalog', this.catalog);
    this.media = new MediaSource();
    this.url = URL.createObjectURL(this.media);
    this.video.src = this.url;
    await this.wait(
      new Promise<void>((resolve) =>
        this.media!.addEventListener('sourceopen', () => resolve(), {
          once: true,
        }),
      ),
    );
    this.media.duration = Infinity;
    const pending: { t: any; sb: SourceBuffer; data: string }[] = [];
    for (const t of this.catalog.tracks) {
      if (
        !['video', 'audio'].includes(t.role) ||
        (t.role === 'audio' && t.name !== this.selectedAudioTrack)
      )
        continue;
      const mime = `${t.role}/mp4; codecs="${t.codec}"`;
      if (!MediaSource.isTypeSupported(mime))
        throw new Error(`Unsupported codec: ${t.codec}`);
      const sb = this.media.addSourceBuffer(mime);
      sb.mode = 'segments';
      const data = this.catalog.initDataList.find(
        (d: any) => d.id === t.initRef,
      )?.data;
      if (typeof data !== 'string')
        throw new Error('Missing media initialization');
      if (t.role === 'video' && t.codec.startsWith('avc1'))
        this.captions = new Cea708Decoder(
          Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
          this.source.captionServices ?? this.catalog.captionServices ?? {},
        );
      pending.push({ t, sb, data });
      if (t.role === 'audio') this.audioBuffer = sb;
    }
    // Read the newest complete video/audio objects first, then request only the
    // recent absolute group window. This avoids replaying the entire relay cache.
    const newest = await Promise.all(
      pending.map(async ({ t }) => {
        const sub = this.subscribe(
          t.name,
          t.role === 'audio' ? 100 : 50,
          undefined,
          true,
        );
        try {
          const frame = await this.wait<
            { payload: Uint8Array; group: bigint } | undefined
          >(sub.reader.readFrame());
          if (!frame) throw new Error(`${t.name} has no cached media`);
          const timing = fragmentTiming(frame.payload, Number(t.timescale));
          return { t, group: frame.group, timing };
        } finally {
          sub.close();
        }
      }),
    );
    const plan = cachedStartPlan(
      newest.find((s) => s.t.role === 'video'),
      newest.find((s) => s.t.role === 'audio'),
      this.targetBuffer,
    );
    this.coldStart = !plan.historyAvailable;
    if (this.coldStart) this.diagnostics.startup.mode = 'cold-prefill';
    // Initialize both SourceBuffers before media. Start readers together so audio
    // and video can fill from cache concurrently.
    for (const { sb, data } of pending)
      await this.append(
        sb,
        Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      );
    this.timer = setInterval(() => this.tick(), 50);
    for (const { t, sb } of pending) {
      if (t.role === 'audio') this.startAudio(t, sb, plan.audio);
      else
        void this.receive(
          t.name,
          sb,
          50,
          Number(t.timescale),
          plan.video,
        ).catch((e) => this.fail(e));
    }
    this.emit(
      'audiochange',
      this.audioTracks.find((t: any) => t.name === this.selectedAudioTrack),
    );
    this.state('buffering');
  }
  subscribe(
    name: string,
    priority = 64,
    start?: bigint,
    latest = false,
    maxDelay = latest ? 0 : 30000,
  ) {
    if (!this.active) throw new Error('Broadcast not connected');
    const track = this.active.track(name).subscribe({
      priority,
      order: latest ? 'descending' : 'ascending',
      ranges: [
        {
          start: start === undefined ? { relative: 0n } : { absolute: start },
        },
      ],
      delay: { max: Moq.Clock.Duration.millis(maxDelay) },
    });
    this.subscriptions.add(track);
    return {
      reader: track.ordered(),
      close: () => {
        track.close();
        this.subscriptions.delete(track);
      },
    };
  }
  private async append(sb: SourceBuffer, data: Uint8Array) {
    if (this.abort.signal.aborted) return;
    await this.wait(
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          sb.removeEventListener('updateend', ok);
          sb.removeEventListener('error', bad);
        };
        const ok = () => {
          cleanup();
          resolve();
        };
        const bad = () => {
          cleanup();
          reject(new Error('MediaSource append failed'));
        };
        sb.addEventListener('updateend', ok, { once: true });
        sb.addEventListener('error', bad, { once: true });
        try {
          sb.appendBuffer(data as BufferSource);
        } catch (e) {
          cleanup();
          reject(e);
        }
      }),
    );
  }
  private async receive(
    name: string,
    sb: SourceBuffer,
    priority: number,
    timescale: number,
    start: bigint,
    session?: any,
  ) {
    const sub = this.subscribe(name, priority, start);
    if (session) session.close = sub.close;
    try {
      while (!this.abort.signal.aborted) {
        const frame = await sub.reader.readFrame();
        if (session?.cancelled || this.abort.signal.aborted) break;
        if (!frame) throw new Error(`${name} track ended`);
        if (frame.payload.byteLength > 16 * 1024 * 1024)
          throw new Error('Media object exceeds limit');
        if (timescale) {
          this.adaptive.observe(
            fragmentTiming(frame.payload, timescale),
            performance.now(),
          );
          if (this.captions)
            try {
              const before = this.captions.tracks.size,
                events = this.captions.push(frame.payload);
              if (this.captions.tracks.size !== before)
                this.emit('subtitletracks', this.subtitleTracks);
              for (const event of events)
                if (event.track.name === this.selectedSubtitleTrack)
                  this.emit('caption', event);
            } catch (e) {
              this.emit('captionwarning', e);
            } // Bad caption metadata must not stop video.
        }
        this.diagnostics.buffer = this.adaptive.snapshot();
        await this.append(sb, frame.payload);
        this.diagnostics.media.push({
          track: name,
          group: String(frame.group),
          at: performance.now(),
          bytes: frame.payload.byteLength,
          ranges: Array.from({ length: sb.buffered.length }, (_, i) => [
            sb.buffered.start(i),
            sb.buffered.end(i),
          ]),
        });
        this.diagnostics.media = this.diagnostics.media.slice(-100);
        this.diagnostics.objects++;
        this.diagnostics.bytes += frame.payload.byteLength;
        const before = this.video.currentTime - 15;
        if (
          before > 0 &&
          sb.buffered.length &&
          sb.buffered.start(0) < before &&
          !sb.updating
        ) {
          await this.wait(
            new Promise<void>((resolve, reject) => {
              sb.addEventListener('updateend', () => resolve(), { once: true });
              try {
                sb.remove(0, before);
              } catch (e) {
                reject(e);
              }
            }),
          );
        }
      }
    } finally {
      sub.close();
    }
  }
  private tick() {
    if (this.switchingAudio) return;
    const b = this.video.buffered;
    if (!b.length) return;
    const start = b.start(b.length - 1),
      end = b.end(b.length - 1);
    this.diagnostics.buffer = this.adaptive.snapshot();
    if (
      this.started &&
      end - this.video.currentTime >= this.targetBuffer &&
      this.diagnostics.startup.reserveReadyMs === null
    )
      this.diagnostics.startup.reserveReadyMs = performance.now() - this.initAt;
    if (!this.started) {
      const required = this.coldStart
        ? this.targetBuffer +
          Math.max(this.adaptive.fragment, this.adaptive.gop)
        : 0.35;
      if (end - start < required) return;
      // The subscription already selected a recent keyframe-backed cache window.
      // Decode its first common A/V range immediately; the rest arrives in a burst.
      this.video.currentTime = start + 0.001;
      this.started = true;
      this.diagnostics.startup.initialBuffer = end - start;
      void this.play();
    } else {
      if (this.rebuffering) {
        const t = this.video.currentTime;
        let ahead = 0;
        for (let i = 0; i < b.length; i++)
          if (t >= b.start(i) && t < b.end(i)) ahead = b.end(i) - t;
        if (ahead >= this.targetBuffer) {
          this.rebuffering = false;
          void this.play();
        } else if (Date.now() - this.lastProgress > 45000) {
          this.lastProgress = Date.now();
          this.fail(new Error('Rebuffering timed out'));
        }
        return;
      }
      // A newly appended range is not a reason to discard the range being played.
      // Jump only over a small timestamp gap once playback actually reaches it.
      const t = this.video.currentTime;
      let containing = -1;
      for (let i = 0; i < b.length; i++)
        if (t >= b.start(i) - 0.05 && t <= b.end(i) + 0.05) {
          containing = i;
          break;
        }
      if (this.video.readyState < 3) {
        const next = containing >= 0 ? containing + 1 : 0;
        if (next < b.length && b.start(next) > t && b.start(next) - t < 0.25)
          this.video.currentTime = b.start(next) + 0.001;
      }
      // Recover small excess latency gradually; leave the normal GOP-sized sawtooth alone.
      if (!this.video.paused && this.video.readyState >= 3) {
        const ahead = containing >= 0 ? b.end(containing) - t : 0;
        const cycle = Math.max(this.adaptive.gop, this.adaptive.fragment, 0.5);
        this.video.playbackRate =
          ahead > this.targetBuffer + 2 * cycle + 0.25
            ? 1.02
            : ahead < this.targetBuffer
              ? 0.98
              : 1;
      }
    }
    this.media?.setLiveSeekableRange(start, end);
    if (this.video.currentTime > this.lastTime) {
      this.lastTime = this.video.currentTime;
      this.lastProgress = Date.now();
    } else if (!this.video.paused && Date.now() - this.lastProgress > 15000) {
      this.lastProgress = Date.now();
      this.fail(new Error('Playback stalled'));
    }
  }

  async play() {
    try {
      await this.video.play();
      if (!this.abort.signal.aborted) this.state('playing');
    } catch (e: any) {
      if (e.name === 'AbortError' || this.abort.signal.aborted) return; // pause/refill or teardown can cancel an in-flight play request
      if (e.name === 'NotAllowedError') this.emit('autoplayblocked', null);
      else this.fail(e);
    }
  }
  async destroy() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    clearInterval(this.timer);
    for (const s of this.subscriptions) s.close();
    this.subscriptions.clear();
    this.broadcast?.close();
    this.origin?.close();
    this.video.pause();
    this.video.playbackRate = 1;
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    const connection = this.connection;
    this.connection = null;
    if (connection)
      await Promise.race([
        connection.close(),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    this.state('closed');
  }
}
