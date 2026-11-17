import { selectRendition } from './selection';
import { AbrController } from './abr';
import { bufferedAhead, nextGapPosition } from './buffer';
import { SubtitleCounters } from '../../subtitles/cues.mjs';
import {
  parsePlaylist,
  alignPlaylist,
  type Playlist,
  type Segment,
  type Resource,
  type Key,
} from './playlist';
import { ResourceClient, delay, type NetworkOptions } from './network';
import { MediaLane, type PreparedSegment } from './media-lane';
import {
  compatibleVariants,
  alignRendition,
  segmentAt,
  switchBoundary,
} from './renditions';
import { nativeCue, parseVtt } from './subtitles';

export interface HlsSource {
  [key: string]: unknown;
  protocol: 'hls';
  url: string;
  network?: NetworkOptions;
  targetBuffer?: number;
  autoplay?: boolean;
  quality?: 'auto' | number;
  audioLanguage?: string;
  subtitleLanguage?: string;
  preferredLanguages?: string[];
}
/** Original baseline HLS engine; no hls.js, VHS or Shaka code/dependency. */
export class HlsEngine extends EventTarget {
  readonly protocol = 'hls';
  readonly stack = 'ThePlayer HLS';
  readonly diagnostics = {
    state: 'idle',
    version: 'baseline',
    objects: 0,
    bytes: 0,
    requests: 0,
    retries: 0,
    bandwidth: 0,
    quality: {} as Record<string, unknown>,
    abrWarning: '',
    switches: [] as { kind: string; name: string; effectiveAt: number }[],
    startup: { firstFrameMs: null as number | null },
    buffer: {} as Record<string, unknown>,
  };
  catalog: any = { profile: 'hls', tracks: [], subtitles: [] };
  isLive = false;
  audioTracks: any[] = [];
  subtitleTracks: any[] = [];
  selectedAudioTrack = '';
  qualityLevels: any[] = [];
  selectedQuality = 0;
  autoQuality = true;
  private abr = new AbrController();
  private qualityTimeline = [{ at: 0, id: 0 }];
  get currentQuality() {
    return (
      this.qualityTimeline.findLast(
        (item) => item.at <= this.video.currentTime + 0.02,
      )?.id ?? this.selectedQuality
    );
  }
  private abrRetryAt = 0;
  private abort = new AbortController();
  private client: ResourceClient;
  private get playlist() {
    return this.main?.playlist;
  }
  private master?: Playlist;
  private media?: MediaSource;
  private mediaUrl?: string;
  private main?: MediaLane;
  private audio?: MediaLane;
  private generation = 0;
  private initial = true;
  private started = false;
  private ended = false;
  private failed = false;
  private subtitleAbort?: AbortController;
  private textTrack?: TextTrack;
  private selectedSubtitle = '';
  private subtitleManual = false;
  private subtitleCounters = new SubtitleCounters();
  private keys = new Map<string, Promise<CryptoKey>>();
  private loadTime = 0;
  private offsets = new Map<number, number>();
  private switches: {
    kind: 'audio' | 'quality';
    index: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  private get timelineOffset() {
    return this.main
      ? (this.offsets.get(this.main.discontinuity) ?? this.main.offset)
      : 0;
  }
  constructor(
    readonly video: HTMLVideoElement,
    readonly source: HlsSource,
  ) {
    super();
    const url = new URL(source.url);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('HLS requires an HTTP(S) URL');
    if (
      source.targetBuffer != null &&
      (!Number.isFinite(source.targetBuffer) ||
        source.targetBuffer < 2 ||
        source.targetBuffer > 120)
    )
      throw new Error('HLS targetBuffer must be between 2 and 120 seconds');
    this.client = new ResourceClient(source.network ?? {}, this.abort.signal);
    video.addEventListener('playing', () => this.state('playing'), {
      signal: this.abort.signal,
    });
    video.addEventListener(
      'waiting',
      () => {
        if (this.started && !video.paused) this.state('buffering');
      },
      { signal: this.abort.signal },
    );
    video.addEventListener('ended', () => this.state('ended'), {
      signal: this.abort.signal,
    });
    video.addEventListener('seeking', () => this.onSeek(), {
      signal: this.abort.signal,
    });
    video.addEventListener(
      'error',
      () => this.fail(new Error(video.error?.message ?? 'HLS decoder error')),
      { signal: this.abort.signal },
    );
  }
  get targetBuffer() {
    return this.source.targetBuffer ?? 12;
  }
  private emit(name: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  private state(state: string) {
    this.diagnostics.state = state;
    this.emit('statechange', state);
  }
  private fail(error: unknown) {
    if (!this.abort.signal.aborted) {
      this.failed = true;
      for (const request of this.switches.splice(0)) request.reject(error);
      this.state('error');
      this.emit(
        'error',
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
  private async readPlaylist(url: string) {
    const response = await this.client.get({ url });
    if (response.data.length > 2 * 1024 * 1024)
      throw new Error('Playlist exceeds 2 MiB');
    const p = parsePlaylist(
      new TextDecoder('utf-8', { fatal: true }).decode(response.data),
      response.url,
      this.master?.variables,
    );
    if (p.unsupported.length)
      throw new Error('Unsupported HLS feature: ' + p.unsupported.join(', '));
    return p;
  }
  private lane(p: Playlist, role: 'main' | 'audio', codecs?: string) {
    return new MediaLane(
      p,
      role,
      (r) => this.client.get(r),
      (data, key, sequence) => this.decrypt(data, key, sequence),
      codecs
        ?.split(',')
        .find((codec) => codec.trim().startsWith('mp4a.'))
        ?.trim(),
    );
  }
  async init() {
    this.state('connecting');
    this.loadTime = performance.now();
    if (typeof MediaSource === 'undefined')
      throw new Error('Media Source Extensions required');
    let p = await this.readPlaylist(this.source.url);
    if (p.variants.length) {
      this.master = p;
      let usable = compatibleVariants(p.variants);
      if (usable.some((v) => v.resolution || v.codecs?.includes('avc')))
        usable = usable.filter(
          (v) => v.resolution || v.codecs?.includes('avc'),
        );
      if (!usable.length) throw new Error('No supported AVC/AAC rendition');
      usable.sort((a, b) => a.bandwidth - b.bandwidth);
      let variant = usable[0];
      // Restrict switches to one audio/subtitle group until cross-group transitions are implemented.
      this.qualityLevels = usable
        .filter(
          (v) => v.audio === variant.audio && v.subtitles === variant.subtitles,
        )
        .map((v, id) => ({
          ...v,
          id,
          label: v.resolution
            ? `${v.resolution.split('x')[1]}p · ${(v.bandwidth / 1e6).toFixed(2)} Mb/s`
            : `${(v.bandwidth / 1e6).toFixed(2)} Mb/s`,
        }));
      if (typeof this.source.quality === 'number') {
        if (
          !Number.isInteger(this.source.quality) ||
          !this.qualityLevels[this.source.quality]
        )
          throw new Error('Unknown initial HLS quality');
        this.autoQuality = false;
        this.selectedQuality = this.source.quality;
        this.qualityTimeline = [{ at: 0, id: this.selectedQuality }];
        variant = this.qualityLevels[this.selectedQuality];
      }
      p = await this.readPlaylist(variant.url);
      this.audioTracks = this.master.renditions
        .filter((r) => r.type === 'AUDIO' && r.group === variant.audio && r.url)
        .map((r, index) => ({
          ...r,
          name: 'hls-audio-' + index,
          label: r.name,
        }));
      this.subtitleTracks = this.master.renditions
        .filter(
          (r) =>
            r.type === 'SUBTITLES' && r.group === variant.subtitles && r.url,
        )
        .map((r, index) => ({
          ...r,
          name: 'hls-sub-' + index,
          language: r.language,
          label: r.name,
          format: 'webvtt',
          url: r.url,
        }));
    }
    this.main = this.lane(
      p,
      'main',
      this.qualityLevels[this.selectedQuality]?.codecs,
    );
    this.isLive = p.live;
    this.main.next = this.startIndex(p);
    const audioTrack = selectRendition(this.audioTracks, 'audio', {
      language: this.source.audioLanguage,
      systemLanguages: this.source.preferredLanguages ?? navigator.languages,
    });
    if (this.audioTracks.length && !audioTrack)
      throw new Error('No automatic audio rendition; specify audioLanguage');
    if (audioTrack) {
      this.audio = this.lane(
        alignRendition(await this.readPlaylist(audioTrack.url), p),
        'audio',
        this.qualityLevels[this.selectedQuality]?.codecs,
      );
      this.audio.next = segmentAt(
        this.audio.playlist,
        p.segments[this.main.next].start,
      );
      this.selectedAudioTrack = audioTrack.name;
    }
    this.state('buffering');
    this.media = new MediaSource();
    this.mediaUrl = URL.createObjectURL(this.media);
    const opened = this.event(this.media, 'sourceopen');
    this.video.src = this.mediaUrl;
    await opened;
    this.media.duration = p.live ? Infinity : p.duration;
    this.emit('streamchange', { live: this.isLive });
    this.emit('subtitletracks', this.subtitleTracks);
    this.emit('qualitylevels', this.qualityLevels);
    this.emit('audiochange', audioTrack ?? null);
    void this.run().catch((error) => this.fail(error));
  }
  private startIndex(p: Playlist) {
    const offset = p.startOffset;
    const time =
      offset != null
        ? offset < 0
          ? Math.max(0, p.duration + offset)
          : offset
        : p.live
          ? Math.max(
              0,
              p.duration -
                Math.max(
                  3 * p.targetDuration,
                  Number(p.serverControl?.['HOLD-BACK']) || 0,
                ),
            )
          : 0;
    return Math.min(p.segments.length - 1, segmentAt(p, time));
  }
  private lanes() {
    return [this.main, this.audio].filter((lane): lane is MediaLane => !!lane);
  }
  private onSeek() {
    if (this.initial || !this.main) return;
    this.generation++;
    for (const lane of this.lanes())
      if (lane.ahead(this.video.currentTime) < 0.1)
        lane.next = segmentAt(lane.playlist, this.video.currentTime);
    this.ended = false;
  }
  private ahead() {
    return bufferedAhead(this.video.buffered, this.video.currentTime);
  }

  private async refresh(lane: MediaLane) {
    const p = lane.playlist;
    if (
      !p.live ||
      performance.now() - lane.refreshedAt < p.targetDuration * 1000
    )
      return;
    const token = this.generation,
      nextSequence =
        p.segments[lane.next]?.sequence ?? p.segments.at(-1)!.sequence + 1;
    const updated = alignPlaylist(await this.readPlaylist(p.url), p);
    lane.playlist = updated;
    lane.refreshedAt = performance.now();
    lane.next =
      token === this.generation
        ? updated.segments.findIndex((s) => s.sequence >= nextSequence)
        : segmentAt(updated, this.video.currentTime);
    if (lane.next < 0) lane.next = updated.segments.length;
  }
  private assertLayout(prepared: PreparedSegment, lane: MediaLane) {
    if (
      lane.role === 'main' &&
      this.audio &&
      prepared.tracks.some((t) => t.kind === 'audio')
    )
      throw new Error('External audio requires a video-only main rendition');
    const codecs = prepared.tracks.map((t) => t.codec).join(',');
    if (
      !MediaSource.isTypeSupported(
        `${prepared.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio'}/mp4; codecs="${codecs}"`,
      )
    )
      throw new Error('Unsupported rendition codec');
  }
  private async appendPrepared(lane: MediaLane, prepared: PreparedSegment) {
    this.assertLayout(prepared, lane);
    lane.configure(this.media!, prepared);
    const offset =
      lane.role === 'audio'
        ? this.offsets.get(prepared.segment.discontinuity)
        : lane.discontinuity !== prepared.segment.discontinuity
          ? prepared.segment.start - prepared.rawStart
          : lane.offset;
    if (offset === undefined)
      throw new Error('Audio discontinuity has no video clock anchor');
    if (
      lane.role === 'main' &&
      !this.offsets.has(prepared.segment.discontinuity)
    )
      this.offsets.set(prepared.segment.discontinuity, offset);
    await lane.append(prepared, offset, (buffer, action) =>
      this.operation(buffer, action),
    );
    this.diagnostics.objects++;
    if (lane.role === 'main') {
      this.abr.observe(prepared.bytes, prepared.elapsed);
      this.diagnostics.bandwidth = this.abr.estimate;
    }
  }
  private async run() {
    // Install every SourceBuffer before appending media, preserving shared A/V ownership.
    const first = await Promise.all(
      this.lanes().map(async (lane) => ({
        lane,
        prepared: await lane.prepare(),
      })),
    );
    for (const { lane, prepared } of first) {
      this.assertLayout(prepared, lane);
      lane.configure(this.media!, prepared);
    }
    for (const { lane, prepared } of first) {
      await this.appendPrepared(lane, prepared);
      lane.next++;
    }
    this.publishCatalog();
    this.selectAutomaticSubtitles();
    while (!this.abort.signal.aborted && !this.failed) {
      if (this.switches.length) {
        const request = this.switches.shift()!;
        try {
          await this.switchRendition(request.kind, request.index);
          request.resolve();
        } catch (error) {
          request.reject(error);
        }
        continue;
      }
      for (const lane of this.lanes()) await this.refresh(lane);
      if (
        this.autoQuality &&
        !this.initial &&
        !this.video.paused &&
        performance.now() >= this.abrRetryAt
      ) {
        const next = this.abr.choose(
          this.qualityLevels,
          this.selectedQuality,
          this.ahead(),
          this.targetBuffer,
          performance.now(),
        );
        if (next !== this.selectedQuality) {
          try {
            await this.switchRendition('quality', next);
          } catch (error) {
            this.diagnostics.abrWarning =
              error instanceof Error ? error.message : String(error);
            this.abrRetryAt = performance.now() + 10000;
          }
        }
      }
      const p = this.main!.playlist;
      if (this.isLive !== p.live) {
        this.isLive = p.live;
        this.emit('streamchange', { live: p.live });
        if (!p.live)
          this.media!.duration =
            p.segments.at(-1)!.start + p.segments.at(-1)!.duration;
      }
      if (this.initial && this.video.buffered.length) {
        this.video.currentTime = this.video.buffered.start(0) + 0.001;
        this.initial = false;
        if (this.source.autoplay !== false) void this.play();
      }
      if (!this.video.paused && this.video.readyState < 3) {
        const position = nextGapPosition(
          this.video.buffered,
          this.video.currentTime,
        );
        if (position !== undefined) this.video.currentTime = position;
      }
      this.updateDiagnostics();
      if (this.media?.readyState === 'open' && p.live) {
        const last = p.segments.at(-1)!;
        this.media.setLiveSeekableRange(
          p.segments[0].start,
          last.start + last.duration,
        );
      }
      const candidates = this.lanes()
        .filter(
          (lane) =>
            lane.next < lane.playlist.segments.length &&
            lane.ahead(this.video.currentTime) < this.targetBuffer,
        )
        .sort(
          (a, b) =>
            a.ahead(this.video.currentTime) - b.ahead(this.video.currentTime),
        );
      let lane = candidates[0];
      if (
        lane?.role === 'audio' &&
        !this.offsets.has(lane.playlist.segments[lane.next].discontinuity)
      ) {
        if (this.main!.next < this.main!.playlist.segments.length)
          lane = this.main!;
        else throw new Error('Audio/video discontinuities do not match');
      }
      if (!lane) {
        if (
          !p.live &&
          this.lanes().every(
            (l) => !l.playlist.live && l.next >= l.playlist.segments.length,
          ) &&
          !this.ended &&
          this.media?.readyState === 'open'
        ) {
          this.media.endOfStream();
          this.ended = true;
        }
        await delay(150, this.abort.signal);
        continue;
      }
      const token = this.generation;
      const prepared = await lane.prepare();
      if (token !== this.generation) continue;
      await this.appendPrepared(lane, prepared);
      if (token === this.generation) lane.next++;
      const cutoff = this.video.currentTime - 30;
      if (
        cutoff > 0 &&
        lane.buffer!.buffered.length &&
        lane.buffer!.buffered.start(0) < cutoff
      )
        await this.operation(lane.buffer!, () =>
          lane.buffer!.remove(0, cutoff),
        );
    }
  }
  private publishCatalog() {
    this.catalog = {
      profile: 'hls',
      tracks: this.lanes().flatMap((lane) =>
        lane.tracks.map((t) => ({ ...t, role: t.kind })),
      ),
      subtitles: this.subtitleTracks,
    };
    this.emit('catalog', this.catalog);
    if (!this.started) {
      this.started = true;
      this.video.requestVideoFrameCallback(() => {
        if (!this.abort.signal.aborted)
          this.diagnostics.startup.firstFrameMs =
            performance.now() - this.loadTime;
      });
    }
  }
  private enqueueSwitch(kind: 'audio' | 'quality', index: number) {
    if (this.abort.signal.aborted || this.failed)
      return Promise.reject(new Error('HLS engine is not active'));
    return new Promise<void>((resolve, reject) => {
      this.switches.push({ kind, index, resolve, reject });
    });
  }
  private async switchRendition(kind: 'audio' | 'quality', index: number) {
    const old = kind === 'audio' ? this.audio : this.main;
    if (!old) throw new Error('Rendition is not ready');
    if (
      (kind === 'quality' && index === this.selectedQuality) ||
      (kind === 'audio' &&
        this.audioTracks[index].name === this.selectedAudioTrack)
    )
      return;
    const choice =
      kind === 'audio' ? this.audioTracks[index] : this.qualityLevels[index];
    const p = alignRendition(await this.readPlaylist(choice.url), old.playlist);
    const lane = this.lane(
      p,
      old.role,
      kind === 'quality'
        ? choice.codecs
        : this.qualityLevels[this.selectedQuality]?.codecs,
    );
    let prepared: PreparedSegment | undefined,
      boundary = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const lead =
        this.abr.estimate && choice.bandwidth
          ? Math.min(
              10,
              ((choice.bandwidth * p.targetDuration) / this.abr.estimate) *
                1.25,
            )
          : 0;
      const bufferedEnd =
        this.video.currentTime + old.ahead(this.video.currentTime);
      // Do not schedule beyond the media we can play while prefetching. A long
      // lead at low bandwidth would otherwise leave an unfilled segment hole.
      boundary = switchBoundary(
        p,
        Math.max(
          this.video.currentTime,
          Math.min(this.video.currentTime + lead, bufferedEnd - 0.16),
        ),
      );
      lane.next = segmentAt(p, boundary);
      const token = this.generation;
      prepared = await lane.prepare();
      this.assertLayout(prepared, lane);
      if (
        token === this.generation &&
        (this.video.currentTime < boundary - 0.03 ||
          (this.video.readyState < 3 &&
            this.video.currentTime <= boundary + 0.1))
      )
        break;
      prepared = undefined;
    }
    if (!prepared)
      throw new Error('Playback advanced beyond the switching boundary; retry');
    this.abort.signal.throwIfAborted();
    lane.inheritBuffer(old);
    lane.offset = old.offset;
    lane.discontinuity = kind === 'quality' ? -1 : old.discontinuity;
    // Let MSE replace overlapping samples in the switching segment. Removing at
    // the playlist boundary first can erase the last old frame before the new
    // rendition's first presentation timestamp (DTS and PTS may differ).
    await this.operation(old.buffer!, () =>
      old.buffer!.remove(boundary + prepared!.segment.duration, Infinity),
    );
    await this.appendPrepared(lane, prepared);
    lane.next++;
    this.ended = false;
    if (kind === 'audio') {
      this.audio = lane;
      this.selectedAudioTrack = choice.name;
      this.emit('audiochange', { ...choice, effectiveAt: boundary });
      if (!this.subtitleManual) this.selectAutomaticSubtitles();
    } else {
      this.main = lane;
      this.selectedQuality = index;
      this.qualityTimeline = this.qualityTimeline.filter(
        (item) => item.at < boundary,
      );
      this.qualityTimeline.push({ at: boundary, id: index });
      this.abr.switched(performance.now());
      this.emit('qualitychange', { ...choice, effectiveAt: boundary });
    }
    this.diagnostics.switches.push({
      kind,
      name: kind === 'audio' ? choice.name : String(index),
      effectiveAt: boundary,
    });
    this.diagnostics.switches = this.diagnostics.switches.slice(-20);
    this.publishCatalog();
  }
  async selectQuality(index: number) {
    if (index === -1) {
      this.autoQuality = true;
      this.abrRetryAt = 0;
      this.emit('qualitychange', { auto: true });
      return;
    }
    if (!Number.isInteger(index) || !this.qualityLevels[index])
      throw new Error('Unknown HLS quality');
    this.autoQuality = false;
    this.emit('qualitychange', { auto: false });
    await this.enqueueSwitch('quality', index);
  }
  private updateDiagnostics() {
    this.diagnostics.quality = {
      mode: this.autoQuality ? 'auto' : 'manual',
      current: this.currentQuality,
      scheduled: this.selectedQuality,
      bandwidthEstimate: this.abr.estimate,
    };
    this.diagnostics.bytes = this.client.bytes;
    this.diagnostics.requests = this.client.requests;
    this.diagnostics.retries = this.client.retries;
    this.diagnostics.buffer = {
      target: this.targetBuffer,
      mode: 'hls-segment',
      ahead: this.ahead(),
      live: this.isLive,
    };
  }
  private async decrypt(
    data: Uint8Array,
    key: Key | undefined,
    sequence: number,
  ) {
    if (!key) return data;
    if (key.method !== 'AES-128' || key.format !== 'identity' || !key.url)
      throw new Error(`Unsupported HLS encryption ${key.method}/${key.format}`);
    let promise = this.keys.get(key.url);
    if (!promise) {
      promise = (async () => {
        const bytes = (await this.client.get({ url: key.url! })).data;
        if (bytes.length !== 16)
          throw new Error('AES-128 key must be 16 bytes');
        return crypto.subtle.importKey(
          'raw',
          bytes as BufferSource,
          'AES-CBC',
          false,
          ['decrypt'],
        );
      })();
      if (this.keys.size >= 32)
        this.keys.delete(this.keys.keys().next().value!);
      this.keys.set(key.url, promise);
    }
    const iv = key.iv ?? new Uint8Array(16);
    if (!key.iv) new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: iv as BufferSource },
        await promise,
        data as BufferSource,
      ),
    );
  }
  private event(target: EventTarget, name: string) {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(name, ok);
        target.removeEventListener('error', bad);
        this.abort.signal.removeEventListener('abort', stop);
      };
      const ok = () => {
          cleanup();
          resolve();
        },
        bad = () => {
          cleanup();
          reject(new Error('HLS media operation failed'));
        },
        stop = () => {
          cleanup();
          reject(this.abort.signal.reason);
        };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('HLS media operation timed out'));
      }, 15000);
      target.addEventListener(name, ok, { once: true });
      target.addEventListener('error', bad, { once: true });
      this.abort.signal.addEventListener('abort', stop, { once: true });
      if (this.abort.signal.aborted) stop();
    });
  }
  private operation(buffer: SourceBuffer, action: () => void) {
    this.abort.signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        buffer.removeEventListener('updateend', done);
        buffer.removeEventListener('error', bad);
        this.abort.signal.removeEventListener('abort', stop);
      };
      const done = () => {
          cleanup();
          resolve();
        },
        bad = () => {
          cleanup();
          reject(new Error('HLS SourceBuffer operation failed'));
        },
        stop = () => {
          cleanup();
          reject(this.abort.signal.reason);
        };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('HLS SourceBuffer timeout'));
      }, 15000);
      buffer.addEventListener('updateend', done, { once: true });
      buffer.addEventListener('error', bad, { once: true });
      this.abort.signal.addEventListener('abort', stop, { once: true });
      try {
        action();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
  async play() {
    try {
      await this.video.play();
    } catch (error) {
      if (this.abort.signal.aborted) return;
      if ((error as Error).name === 'NotAllowedError')
        this.emit('autoplayblocked', null);
      else if ((error as Error).name !== 'AbortError') this.fail(error);
    }
  }
  async selectAudioTrack(name: string) {
    const index = this.audioTracks.findIndex((t) => t.name === name);
    if (index < 0) throw new Error('Unknown HLS audio track');
    await this.enqueueSwitch('audio', index);
  }
  private selectAutomaticSubtitles() {
    const audio = this.audioTracks.find(
      (t) => t.name === this.selectedAudioTrack,
    );
    const track = selectRendition(this.subtitleTracks, 'subtitles', {
      language: this.source.subtitleLanguage,
      systemLanguages:
        this.source.preferredLanguages ??
        (audio?.language ? [audio.language] : navigator.languages),
    });
    if ((track?.name ?? '') !== this.selectedSubtitle)
      this.selectSubtitleTrack(track?.name ?? '', true);
  }
  selectSubtitleTrack(name: string, automatic = false) {
    if (!automatic) this.subtitleManual = true;
    const track = this.subtitleTracks.find((t) => t.name === name);
    if (name && !track) throw new Error('Unknown HLS subtitle track');
    this.subtitleAbort?.abort();
    this.subtitleAbort = undefined;
    this.selectedSubtitle = name;
    if (this.textTrack) {
      this.textTrack.mode = 'disabled';
      for (const cue of Array.from(this.textTrack.cues ?? []))
        this.textTrack.removeCue(cue);
    }
    this.subtitleCounters.present(null, false);
    this.emit('subtitlechange', track ?? null);
    if (!track) return;
    const abort = (this.subtitleAbort = new AbortController());
    const stop = () => abort.abort();
    this.abort.signal.addEventListener('abort', stop, { once: true });
    this.textTrack ??= this.video.addTextTrack('subtitles', 'ThePlayer HLS');
    const textTrack = this.textTrack;
    textTrack.mode = 'showing';
    const update = () => {
      const text = Array.from(textTrack.activeCues ?? [])
        .map((c) => (c as VTTCue).text)
        .join('\n');
      this.subtitleCounters.present(text ? { text, rects: [] } : null, !!text);
      this.emit('subtitlemetrics', {
        received: this.subtitleCounters.received,
        displayed: this.subtitleCounters.displayed,
      });
    };
    textTrack.addEventListener('cuechange', update, { signal: abort.signal });

    void (async () => {
      const client = new ResourceClient(
        this.source.network ?? {},
        abort.signal,
      );
      const seen = new Map<string, number>();
      let p: Playlist | undefined,
        refreshedAt = 0;
      while (!abort.signal.aborted) {
        if (
          !p ||
          (p.live && performance.now() - refreshedAt >= p.targetDuration * 1000)
        ) {
          const response = await client.get({ url: track.url });
          const updated = parsePlaylist(
            new TextDecoder().decode(response.data),
            response.url,
            this.master?.variables,
          );
          p = p && updated.live ? alignPlaylist(updated, p) : updated;
          refreshedAt = performance.now();
        }
        const time = this.video.currentTime;
        for (const segment of p.segments) {
          const id = segment.url + JSON.stringify(segment.range);
          if (
            seen.has(id) ||
            segment.start + segment.duration < time - 5 ||
            segment.start > time + this.targetBuffer
          )
            continue;
          if (segment.key || segment.map)
            throw new Error(
              'Encrypted/WebVTT-in-MP4 subtitles are not yet supported',
            );
          const response = await client.get(segment);
          abort.signal.throwIfAborted();
          const cues = parseVtt(
            new TextDecoder().decode(response.data),
            this.timelineOffset,
          );
          for (const cue of cues) {
            textTrack.addCue(nativeCue(cue));
            this.subtitleCounters.receive();
          }
          update();
          seen.set(id, segment.start + segment.duration);
        }
        for (const cue of Array.from(textTrack.cues ?? []))
          if (cue.endTime < this.video.currentTime - 30)
            textTrack.removeCue(cue);
        for (const [id, end] of seen)
          if (end < this.video.currentTime - 30) seen.delete(id);
        await delay(500, abort.signal);
      }
    })()
      .catch((error) => {
        if (!abort.signal.aborted) this.emit('captionwarning', error);
      })
      .finally(() => this.abort.signal.removeEventListener('abort', stop));
  }
  seekToLive() {
    if (!this.isLive || !this.playlist) return;
    const p = this.playlist,
      last = p.segments.at(-1)!;
    this.video.currentTime = Math.max(
      p.segments[0].start,
      last.start + last.duration - 3 * p.targetDuration,
    );
    void this.play();
  }
  async destroy() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    for (const request of this.switches.splice(0))
      request.reject(new DOMException('Player closed', 'AbortError'));
    this.subtitleAbort?.abort();
    if (this.textTrack) {
      this.textTrack.mode = 'disabled';
      for (const cue of Array.from(this.textTrack.cues ?? []))
        this.textTrack.removeCue(cue);
    }
    this.video.pause();
    this.video.playbackRate = 1;
    this.video.removeAttribute('src');
    this.video.load();
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.keys.clear();
    this.state('closed');
  }
}
