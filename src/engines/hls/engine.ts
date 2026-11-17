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
import { inspectInit, decodeTime, type Track } from './mp4';
import { TsTransmuxer } from './transport-stream';
import { nativeCue, parseVtt } from './subtitles';

export interface HlsSource {
  [key: string]: unknown;
  protocol: 'hls';
  url: string;
  network?: NetworkOptions;
  targetBuffer?: number;
  autoplay?: boolean;
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
    startup: { firstFrameMs: null as number | null },
    buffer: {} as Record<string, unknown>,
  };
  catalog: any = { profile: 'hls', tracks: [], subtitles: [] };
  isLive = false;
  audioTracks: any[] = [];
  subtitleTracks: any[] = [];
  selectedAudioTrack = '';
  qualityLevels: any[] = [];
  selectedQuality = -1;
  private abort = new AbortController();
  private client: ResourceClient;
  private playlist?: Playlist;
  private master?: Playlist;
  private media?: MediaSource;
  private mediaUrl?: string;
  private buffer?: SourceBuffer;
  private tracks: Track[] = [];
  private mapId = '';
  private codec = '';
  private transmuxer = new TsTransmuxer();
  private timelineOffset = 0;
  private discontinuity = -1;
  private next = 0;
  private generation = 0;
  private initial = true;
  private started = false;
  private ended = false;
  private failed = false;
  private subtitleAbort?: AbortController;
  private textTrack?: TextTrack;
  private selectedSubtitle = '';
  private subtitleCounters = new SubtitleCounters();
  private keys = new Map<string, Promise<CryptoKey>>();
  private loadedAt = 0;
  private loadTime = 0;
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
  async init() {
    this.state('connecting');
    this.loadTime = performance.now();
    if (typeof MediaSource === 'undefined')
      throw new Error('Media Source Extensions required');
    let p = await this.readPlaylist(this.source.url);
    if (p.variants.length) {
      this.master = p;
      const usable = p.variants.filter(
        (v) =>
          !v.audio ||
          !p.renditions.some(
            (r) => r.type === 'AUDIO' && r.group === v.audio && r.url,
          ),
      );
      if (!usable.length)
        throw new Error(
          'External HLS audio renditions are not yet implemented',
        );
      const variant = [...usable].sort((a, b) => a.bandwidth - b.bandwidth)[0];
      // The baseline selects a rendition once. Do not advertise ABR until switching is tested.
      p = await this.readPlaylist(variant.url);
      this.subtitleTracks = this.master.renditions
        .filter(
          (r) =>
            r.type === 'SUBTITLES' && r.group === variant.subtitles && r.url,
        )
        .map((r, index) => ({
          name: 'hls-sub-' + index,
          language: r.language,
          label: r.name,
          format: 'webvtt',
          url: r.url,
        }));
    }
    this.playlist = p;
    this.isLive = p.live;
    this.loadedAt = performance.now();
    this.next = this.startIndex(p);
    this.state('buffering');
    this.media = new MediaSource();
    this.mediaUrl = URL.createObjectURL(this.media);
    const opened = this.event(this.media, 'sourceopen');
    this.video.src = this.mediaUrl;
    await opened;
    this.media.duration = p.live ? Infinity : p.duration;
    this.emit('streamchange', { live: this.isLive });
    this.emit('subtitletracks', this.subtitleTracks);
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
    return Math.max(
      0,
      p.segments.findIndex((s) => s.start + s.duration > time),
    );
  }
  private onSeek() {
    if (this.initial || !this.playlist) return;
    const time = this.video.currentTime;
    if (
      this.buffer &&
      Array.from({ length: this.buffer.buffered.length }, (_, i) => [
        this.buffer!.buffered.start(i),
        this.buffer!.buffered.end(i),
      ]).some(([start, end]) => time >= start && time < end - 0.1)
    )
      return;
    const index = this.playlist.segments.findIndex(
      (s) => time >= s.start && time < s.start + s.duration,
    );
    if (index < 0) return;
    this.generation++;
    this.next = index;
    this.ended = false;
  }
  private ahead() {
    const b = this.video.buffered,
      t = this.video.currentTime;
    for (let i = 0; i < b.length; i++)
      if (t >= b.start(i) - 0.1 && t <= b.end(i)) return b.end(i) - t;
    return 0;
  }
  private async run() {
    while (!this.abort.signal.aborted && !this.failed) {
      let p = this.playlist!;
      if (
        p.live &&
        performance.now() - this.loadedAt >= p.targetDuration * 1000
      ) {
        const nextSequence =
          p.segments[this.next]?.sequence ?? p.segments.at(-1)!.sequence + 1;
        const updated = await this.readPlaylist(p.url);
        p = this.playlist = alignPlaylist(updated, p);
        this.loadedAt = performance.now();
        this.next = p.segments.findIndex((s) => s.sequence >= nextSequence);
        if (this.next < 0) this.next = p.segments.length;
        if (this.isLive !== p.live) {
          this.isLive = p.live;
          this.emit('streamchange', { live: p.live });
          if (!p.live)
            this.media!.duration =
              p.segments.at(-1)!.start + p.segments.at(-1)!.duration;
        }
      }
      this.updateDiagnostics();
      if (this.ahead() >= this.targetBuffer || this.next >= p.segments.length) {
        if (
          !p.live &&
          this.next >= p.segments.length &&
          !this.ended &&
          this.media?.readyState === 'open'
        ) {
          this.media.endOfStream();
          this.ended = true;
        }
        await delay(150, this.abort.signal);
        continue;
      }
      const segment = p.segments[this.next],
        token = this.generation;
      if (segment.gap) {
        throw new Error('HLS GAP recovery is not yet implemented');
      }
      const response = await this.client.get(segment);
      let data = await this.decrypt(
        response.data,
        segment.key,
        segment.sequence,
      );
      if (token !== this.generation) continue;
      let init: Uint8Array | undefined, rawStart: number;
      const discontinuity = segment.discontinuity !== this.discontinuity;
      if (discontinuity) {
        this.transmuxer.reset();
        this.mapId = '';
      }
      if (segment.map) {
        const id = JSON.stringify(segment.map);
        if (id !== this.mapId) {
          const map = await this.client.get(segment.map);
          if (segment.key && !segment.key.iv)
            throw new Error('Encrypted initialization needs an explicit IV');
          init = await this.decrypt(map.data, segment.key, segment.sequence);
          this.tracks = inspectInit(init);
          this.mapId = id;
        }
        rawStart = decodeTime(data, this.tracks);
      } else if (data[0] === 0x47) {
        const result = this.transmuxer.transmux(data, segment.duration);
        this.tracks = result.tracks;
        data = result.media;
        rawStart = result.start;
        if (
          !this.buffer ||
          discontinuity ||
          this.codec !== this.tracks.map((t) => t.codec).join(',')
        )
          init = result.init;
      } else throw new Error('Expected MPEG-TS or fMP4 with EXT-X-MAP');
      if (token !== this.generation) continue;
      const codec = this.tracks.map((t) => t.codec).join(','),
        mime = `${this.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio'}/mp4; codecs="${codec}"`;
      if (!MediaSource.isTypeSupported(mime))
        throw new Error('Unsupported browser codec: ' + codec);
      if (!this.buffer) {
        this.buffer = this.media!.addSourceBuffer(mime);
        this.buffer.mode = 'segments';
      } else if (codec !== this.codec) {
        this.buffer.changeType(mime);
      }
      this.codec = codec;
      if (discontinuity) {
        this.timelineOffset = segment.start - rawStart;
        this.buffer.timestampOffset = this.timelineOffset;
        this.discontinuity = segment.discontinuity;
      }
      if (init) await this.append(init);
      await this.append(data);
      this.next++;
      this.diagnostics.objects++;
      this.diagnostics.bandwidth =
        (response.data.length * 8) / Math.max(0.001, response.elapsed / 1000);
      this.catalog = {
        profile: 'hls',
        tracks: this.tracks.map((t) => ({ ...t, role: t.kind })),
        subtitles: this.subtitleTracks,
      };
      if (!this.started) {
        this.emit('catalog', this.catalog);
        this.started = true;
        this.video.requestVideoFrameCallback(() => {
          if (!this.abort.signal.aborted)
            this.diagnostics.startup.firstFrameMs =
              performance.now() - this.loadTime;
        });
      }
      if (this.initial && this.video.buffered.length) {
        this.video.currentTime = this.video.buffered.start(0) + 0.001;
        this.initial = false;
        if (this.source.autoplay !== false) void this.play();
      }
      if (this.media?.readyState === 'open' && p.live) {
        const last = p.segments.at(-1)!;
        this.media.setLiveSeekableRange(
          p.segments[0].start,
          last.start + last.duration,
        );
      }
      const cutoff = this.video.currentTime - 30;
      if (
        cutoff > 0 &&
        this.buffer.buffered.length &&
        this.buffer.buffered.start(0) < cutoff
      ) {
        const done = this.event(this.buffer, 'updateend');
        this.buffer.remove(0, cutoff);
        await done;
      }
    }
  }
  private updateDiagnostics() {
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
  private async append(data: Uint8Array) {
    this.abort.signal.throwIfAborted();
    const done = this.event(this.buffer!, 'updateend');
    try {
      this.buffer!.appendBuffer(data as BufferSource);
    } catch (error) {
      void done.catch(() => {});
      throw error;
    }
    await done;
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
  async selectAudioTrack(_name: string) {
    throw new Error('Alternate HLS audio is not yet implemented');
  }
  selectSubtitleTrack(name: string) {
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
      const seen = new Set<string>();
      while (!abort.signal.aborted) {
        const response = await client.get({ url: track.url });
        const p = parsePlaylist(
          new TextDecoder().decode(response.data),
          response.url,
        );
        for (const segment of p.segments) {
          const id = segment.url + JSON.stringify(segment.range);
          if (seen.has(id)) continue;
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
          seen.add(id);
        }
        if (!p.live) break;
        for (const cue of Array.from(textTrack.cues ?? []))
          if (cue.endTime < this.video.currentTime - 30)
            textTrack.removeCue(cue);
        const current = new Set(
          p.segments.map((s) => s.url + JSON.stringify(s.range)),
        );
        for (const key of seen) if (!current.has(key)) seen.delete(key);
        await delay(p.targetDuration * 1000, abort.signal);
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
