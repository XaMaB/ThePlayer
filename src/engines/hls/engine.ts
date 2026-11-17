import { TtmlRenderer } from './ttml-renderer';
import { parseTtml } from './ttml';
import { textMetadata, textSamples } from './text-mp4';
import { PlaylistLoader } from './playlist-reload';
import { LiveProgress, reconcileLive } from './live';
import { Cea608Timeline } from './cea608-timeline';
import { row608Text } from './cea608';
import type { Track } from './mp4';
import { selectRendition } from './selection';
import { AbrController, EmergencySwitch } from './abr';
import { bufferedAhead, nextGapPosition, declaredGapPosition } from './buffer';
import { SubtitleCounters } from '../../subtitles/cues.mjs';
import {
  parsePlaylist,
  alignPlaylist,
  independentIndex,
  holdBack,
  type Playlist,
  type Segment,
  type Resource,
  type Key,
} from './playlist';
import { ResourceClient, delay, type NetworkOptions } from './network';
import { MediaLane, type PreparedSegment } from './media-lane';
import {
  browserVariants,
  hasVideo,
  alignRendition,
  segmentAt,
  switchBoundary,
} from './renditions';
import {
  nativeCue,
  parseVtt,
  vttHeaders,
  WebVttStyles,
  type VttRegionData,
} from './subtitles';

export interface HlsSource {
  [key: string]: unknown;
  protocol: 'hls';
  url: string;
  network?: NetworkOptions;
  targetBuffer?: number;
  liveStallTimeoutMs?: number;
  liveRecoveryTimeoutMs?: number;
  autoplay?: boolean;
  quality?: 'auto' | number;
  media?: 'video' | 'audio';
  startTime?: number;
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
    declaredGaps: 0,
    audioClockRebases: 0,
    live: {
      stale: false,
      unchangedMs: 0,
      restarts: 0,
      reason: '',
      lanes: {} as Record<string, { unchangedMs: number; stale: boolean }>,
    },
    recovery: {} as Record<string, unknown>,
    playlistReload: {} as Record<string, unknown>,
    preload: {} as Record<string, unknown>,
    bandwidth: 0,
    quality: {} as Record<string, unknown>,
    abrWarning: '',
    abrRecovery: {
      aborted: 0,
      failovers: 0,
      quarantined: [] as { index: number; until: number; reason: string }[],
    },
    unsupportedCaptions: [] as { id: number; format: string }[],
    captions608: { packets: 0, parityErrors: 0, events: 0, warning: '' },
    switches: [] as { kind: string; name: string; effectiveAt: number }[],
    startup: { firstFrameMs: null as number | null },
    buffer: {} as Record<string, unknown>,
  };
  catalog: any = { profile: 'hls', tracks: [], subtitles: [] };
  isLive = false;
  mediaMode: 'video' | 'audio' = 'video';
  availableMediaModes: ('video' | 'audio')[] = [];
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
  private abrRecovering = false;
  private liveProgress = new LiveProgress();
  private restartTimes: number[] = [];
  private resumeAfterReset?: boolean;
  private gaps: { start: number; end: number }[] = [];
  private abort = new AbortController();
  private client: ResourceClient;
  private playlistLoader: PlaylistLoader;
  private get playlist() {
    return this.main?.playlist;
  }
  private master?: Playlist;
  private captions608 = new Cea608Timeline();
  private captions608Seen = new Map<string, number>();
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
  private ttmlRenderer?: TtmlRenderer;
  private vttStyles?: WebVttStyles;
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
    if (source.media != null && !['video', 'audio'].includes(source.media))
      throw new Error('Unknown HLS media mode');
    if (
      source.startTime != null &&
      (!Number.isFinite(source.startTime) || source.startTime < 0)
    )
      throw new Error('Invalid HLS startTime');
    for (const value of [
      source.liveStallTimeoutMs,
      source.liveRecoveryTimeoutMs,
    ])
      if (value != null && (!Number.isFinite(value) || value < 1000))
        throw new Error('Live recovery timeouts must be at least 1000 ms');
    if (
      source.liveRecoveryTimeoutMs != null &&
      source.liveRecoveryTimeoutMs < (source.liveStallTimeoutMs ?? 30000)
    )
      throw new Error(
        'Live recovery timeout must not precede the stale threshold',
      );
    this.client = new ResourceClient(source.network ?? {}, this.abort.signal);
    this.playlistLoader = new PlaylistLoader(
      this.client,
      () => this.master?.variables ?? {},
    );
    this.diagnostics.recovery = this.client.recovery;
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
  private readPlaylist(url: string, recoveryWindowMs?: number) {
    return this.playlistLoader.read(url, recoveryWindowMs);
  }
  private lane(p: Playlist, role: 'main' | 'audio', codecs?: string) {
    return new MediaLane(
      p,
      role,
      async (r) => {
        const hinted = await this.playlistLoader.preload.take(r);
        if (hinted) return hinted;
        const active =
          role === 'main' &&
          this.autoQuality &&
          this.selectedQuality > 0 &&
          this.main?.playlist.url === p.url &&
          !this.initial &&
          'duration' in r;
        return this.client.get(r, {
          recoveryWindowMs: active || this.abrRecovering ? 0 : undefined,
          onProgress: active
            ? (progress) => {
                if (
                  !this.autoQuality ||
                  this.video.paused ||
                  this.main?.playlist.url !== p.url
                )
                  return;
                const index = this.abr.emergency(
                  this.qualityLevels,
                  this.selectedQuality,
                  progress,
                  this.ahead(),
                  Number((r as { duration: number }).duration),
                  performance.now(),
                );
                if (index !== undefined) {
                  this.abr.observe(progress.loaded, progress.elapsedMs);
                  throw new EmergencySwitch(index);
                }
              }
            : undefined,
        });
      },
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
      let usable = browserVariants(p.variants, (mime) =>
        MediaSource.isTypeSupported(mime),
      );
      this.availableMediaModes = [];
      if (usable.some(hasVideo)) this.availableMediaModes.push('video');
      if (usable.some((v) => !hasVideo(v)))
        this.availableMediaModes.push('audio');
      this.mediaMode =
        this.source.media ?? (p.variants.some(hasVideo) ? 'video' : 'audio');
      usable = usable.filter(
        (v) => hasVideo(v) === (this.mediaMode === 'video'),
      );
      if (!usable.length)
        throw new Error(
          'No supported ' + this.mediaMode + ' rendition for this browser',
        );
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
    const offset = this.source.startTime ?? p.startOffset;
    const time =
      offset != null
        ? offset < 0
          ? Math.max(0, p.duration + offset)
          : offset
        : p.live
          ? Math.max(0, p.duration - holdBack(p))
          : 0;
    return independentIndex(p, segmentAt(p, time));
  }
  private lanes() {
    return [this.main, this.audio].filter((lane): lane is MediaLane => !!lane);
  }
  private onSeek() {
    if (this.initial || !this.main) return;
    if (
      this.lanes().every((lane) => lane.ahead(this.video.currentTime) >= 0.1)
    ) {
      this.ended = false;
      return;
    }
    this.generation++;
    for (const lane of this.lanes())
      if (lane.ahead(this.video.currentTime) < 0.1)
        // Seeking exactly to duration still needs the last segment. Otherwise
        // endOfStream() can shorten the duration to the buffered prefix.
        lane.next = independentIndex(
          lane.playlist,
          segmentAt(lane.playlist, this.video.currentTime),
        );
    if (
      this.main.ahead(this.video.currentTime) < 0.1 &&
      this.subtitleTracks.some((t) => t.format === 'cea-608')
    ) {
      this.captions608.reset();
      this.main.next = Math.max(0, this.main.next - 3);
      if (!this.subtitleManual) this.selectAutomaticSubtitles();
      if (this.selectedSubtitle.startsWith('hls-608-')) this.render608();
    }
    this.ended = false;
  }
  private ahead() {
    return bufferedAhead(this.video.buffered, this.video.currentTime);
  }

  private async refresh(lane: MediaLane) {
    const p = lane.playlist;
    if (!p.live) return;
    const age = performance.now() - lane.refreshedAt;
    const blocking = this.playlistLoader.blocking(p);
    if (
      blocking
        ? age < 100 ||
          (lane.next < p.segments.length &&
            lane.ahead(this.video.currentTime) < this.targetBuffer)
        : age < p.targetDuration * 1000
    )
      return;
    const token = this.generation,
      nextSequence =
        p.segments[lane.next]?.sequence ?? p.segments.at(-1)!.sequence + 1;
    const nextTime =
      p.segments[lane.next]?.start ??
      p.segments.at(-1)!.start + p.segments.at(-1)!.duration;
    const incoming = await this.playlistLoader.reload(
      p,
      performance.now() - lane.refreshedAt,
    );
    const unchanged = this.liveProgress.observe(incoming, performance.now());
    const staleAfter =
      this.source.liveStallTimeoutMs ??
      Math.max(30000, p.targetDuration * 3000);
    this.diagnostics.live.lanes[lane.role] = {
      unchangedMs: unchanged,
      stale: incoming.live && unchanged >= staleAfter,
    };
    this.diagnostics.live.stale = Object.values(
      this.diagnostics.live.lanes,
    ).some((l) => l.stale);
    this.diagnostics.live.unchangedMs = Math.max(
      ...Object.values(this.diagnostics.live.lanes).map((l) => l.unchangedMs),
    );
    if (
      incoming.live &&
      unchanged >=
        (this.source.liveRecoveryTimeoutMs ?? Math.max(120000, staleAfter * 2))
    )
      throw new Error(
        'HLS live playlist stopped advancing beyond recovery timeout',
      );
    const result = reconcileLive(incoming, p, nextSequence);
    if (result.restart) {
      await this.restartLive(
        lane === this.main ? incoming : undefined,
        result.reason,
      );
      return;
    }
    const updated = result.playlist;
    lane.playlist = updated;
    lane.refreshedAt = performance.now();
    lane.next =
      token === this.generation
        ? segmentAt(updated, nextTime)
        : segmentAt(updated, this.video.currentTime);
    if (lane.next < 0) lane.next = updated.segments.length;
  }
  private async restartLive(incoming: Playlist | undefined, reason: string) {
    const now = performance.now();
    this.restartTimes = this.restartTimes.filter((at) => now - at < 60000);
    if (this.restartTimes.length >= 3)
      throw new Error('HLS live source repeatedly reset its timeline');
    this.restartTimes.push(now);
    const main = incoming ?? (await this.readPlaylist(this.main!.playlist.url));
    const audio = this.audio
      ? alignRendition(await this.readPlaylist(this.audio.playlist.url), main)
      : undefined;
    // Fetch and validate both playlists before releasing the old presentation.
    const play = !this.video.paused;
    this.initial = true;
    this.resumeAfterReset = play;
    this.generation++;
    this.subtitleAbort?.abort();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
    this.offsets.clear();
    this.keys.clear();
    this.gaps = [];
    this.captions608.reset();
    this.captions608Seen.clear();
    this.liveProgress.reset();
    this.ended = false;
    this.main = this.lane(
      main,
      'main',
      this.qualityLevels[this.selectedQuality]?.codecs,
    );
    this.main.next = independentIndex(
      main,
      segmentAt(
        main,
        Math.max(
          main.segments[0].start,
          main.segments.at(-1)!.start +
            main.segments.at(-1)!.duration -
            holdBack(main),
        ),
      ),
    );
    this.audio = audio ? this.lane(audio, 'audio') : undefined;
    if (this.audio)
      this.audio.next = segmentAt(audio!, main.segments[this.main.next].start);
    this.isLive = main.live;
    this.diagnostics.live.restarts++;
    this.diagnostics.live.reason = reason;
    this.diagnostics.live.stale = false;
    this.diagnostics.live.lanes = {};
    this.qualityTimeline = [{ at: 0, id: this.selectedQuality }];
    this.media = new MediaSource();
    this.mediaUrl = URL.createObjectURL(this.media);
    const opened = this.event(this.media, 'sourceopen');
    this.video.src = this.mediaUrl;
    await opened;
    this.media.duration = main.live ? Infinity : main.duration;
    this.state('buffering');
    this.emit('streamchange', { live: this.isLive });
    await this.prime();
  }
  private assertLayout(prepared: PreparedSegment, lane: MediaLane) {
    if (
      lane.role === 'main' &&
      this.audio &&
      prepared.tracks.some((t) => t.kind === 'audio')
    )
      throw new Error('External audio requires a video-only main rendition');
    if (
      lane.role === 'main' &&
      this.source.media === 'audio' &&
      prepared.tracks.some((t) => t.kind === 'video')
    )
      throw new Error('Audio-only mode requires an audio-only rendition');
    if (
      lane.role === 'main' &&
      this.master &&
      this.mediaMode === 'video' &&
      !prepared.tracks.some((t) => t.kind === 'video')
    )
      throw new Error('Video rendition contains no supported video track');
    const codecs = prepared.tracks.map((t) => t.codec).join(',');
    if (
      !MediaSource.isTypeSupported(
        `${prepared.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio'}/mp4; codecs="${codecs}"`,
      )
    )
      throw new Error('Unsupported browser codec: ' + codecs);
  }
  private async appendPrepared(lane: MediaLane, prepared: PreparedSegment) {
    if (lane.role === 'main')
      this.diagnostics.unsupportedCaptions = prepared.ignoredCaptions.filter(
        (t) => t.format !== 'c608',
      );
    this.assertLayout(prepared, lane);
    lane.configure(this.media!, prepared);
    let offset =
      lane.role === 'audio'
        ? lane.discontinuity === prepared.segment.discontinuity
          ? lane.offset
          : this.offsets.get(prepared.segment.discontinuity)
        : lane.discontinuity !== prepared.segment.discontinuity
          ? prepared.segment.start - prepared.rawStart
          : lane.offset;
    if (offset === undefined)
      throw new Error('Audio discontinuity has no video clock anchor');
    if (
      lane.role === 'audio' &&
      lane.discontinuity !== prepared.segment.discontinuity &&
      Math.abs(prepared.rawStart + offset - prepared.segment.start) >
        Math.max(1, lane.playlist.targetDuration)
    ) {
      // Rendition playlists have already been aligned by PDT or sequence. A
      // different raw clock must not turn all audio timestamps negative after reset.
      offset = prepared.segment.start - prepared.rawStart;
      this.diagnostics.audioClockRebases++;
    }
    if (
      lane.role === 'main' &&
      !this.offsets.has(prepared.segment.discontinuity)
    )
      this.offsets.set(prepared.segment.discontinuity, offset);
    await lane.append(prepared, offset, (buffer, action) =>
      this.operation(buffer, action),
    );
    if (
      lane.role === 'main' &&
      prepared.ignoredCaptions.some((t) => t.format === 'c608')
    ) {
      this.captions608.update(
        prepared.captionPackets,
        offset,
        prepared.segment.start,
        prepared.segment.start + prepared.segment.duration,
        prepared.segment.discontinuity,
        this.video.currentTime,
        lane !== this.main,
      );
      this.diagnostics.captions608.packets += prepared.captionPackets.length;
      this.diagnostics.captions608.parityErrors = this.captions608.parityErrors;
      this.diagnostics.captions608.events = this.captions608.events.filter(
        (e) => e.rows.length && !e.checkpoint,
      ).length;
      this.diagnostics.captions608.warning = prepared.captionError ?? '';
      for (const service of [1, 2]) {
        const name = 'hls-608-' + service;
        if (this.subtitleTracks.some((t) => t.name === name)) continue;
        const group = this.qualityLevels[this.selectedQuality]?.closedCaptions;
        const metadata = this.master?.renditions.find(
          (r) =>
            r.type === 'CLOSED-CAPTIONS' &&
            r.group === group &&
            r.instreamId === 'CC' + service,
        );
        if (
          service === 2 &&
          !metadata &&
          !this.captions608.events.some((e) => e.service === 2 && e.rows.length)
        )
          continue;
        this.subtitleTracks.push({
          name,
          format: 'cea-608',
          service,
          language: metadata?.language ?? 'und',
          label: (metadata?.name ? metadata.name + ' · ' : '') + 'CC' + service,
          default: metadata?.default ?? false,
          autoselect: metadata?.autoselect ?? false,
          forced: false,
        });
        this.emit('subtitletracks', this.subtitleTracks);
      }
      if (!this.subtitleManual) this.selectAutomaticSubtitles();
      if (this.selectedSubtitle.startsWith('hls-608-')) this.render608();
    }
    this.diagnostics.objects++;
    if (lane.role === 'main') {
      this.abr.observe(prepared.bytes, prepared.elapsed);
      this.diagnostics.bandwidth = this.abr.estimate;
    }
  }
  private skipDeclaredGaps(lane: MediaLane) {
    while (lane.playlist.segments[lane.next]?.gap) {
      const segment = lane.playlist.segments[lane.next++];
      const gap = {
        start: segment.start,
        end: segment.start + segment.duration,
      };
      if (!this.gaps.some((g) => g.start === gap.start && g.end === gap.end)) {
        this.gaps.push(gap);
        this.diagnostics.declaredGaps++;
      }
    }
    this.gaps = this.gaps.filter((g) => g.end >= this.video.currentTime - 35);
  }
  private async prime() {
    for (const lane of this.lanes()) this.skipDeclaredGaps(lane);
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
    if (this.subtitleManual)
      this.selectSubtitleTrack(this.selectedSubtitle, true);
    else this.selectAutomaticSubtitles();
    for (const lane of this.lanes())
      this.liveProgress.observe(lane.playlist, performance.now());
  }
  private async run() {
    await this.prime();
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
      for (const lane of this.lanes()) {
        await this.refresh(lane);
        if (lane !== this.main && lane !== this.audio) break;
        this.skipDeclaredGaps(lane);
      }
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
            this.abr.quarantine(
              next,
              performance.now(),
              this.diagnostics.abrWarning,
            );
            this.abrRetryAt = performance.now() + 1000;
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
        this.video.currentTime = Math.max(
          this.video.buffered.start(0) + 0.001,
          Math.min(
            this.resumeAfterReset !== undefined
              ? 0
              : (this.source.startTime ?? 0),
            this.video.buffered.end(0) - 0.001,
          ),
        );
        this.mediaMode = this.main!.tracks.some((t) => t.kind === 'video')
          ? 'video'
          : 'audio';
        if (!this.availableMediaModes.length)
          this.availableMediaModes = [this.mediaMode];
        this.initial = false;
        const autoplay =
          this.resumeAfterReset ?? this.source.autoplay !== false;
        this.resumeAfterReset = undefined;
        if (autoplay) void this.play();
      }
      if (!this.video.paused && this.video.readyState < 3) {
        const position =
          declaredGapPosition(
            this.video.buffered,
            this.video.currentTime,
            this.gaps,
          ) ?? nextGapPosition(this.video.buffered, this.video.currentTime);
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
      try {
        const prepared = await lane.prepare();
        if (token !== this.generation) continue;
        await this.appendPrepared(lane, prepared);
        if (token === this.generation) lane.next++;
      } catch (error) {
        this.abort.signal.throwIfAborted();
        if (token !== this.generation) continue;
        if (
          lane.role !== 'main' ||
          !this.autoQuality ||
          this.selectedQuality <= 0
        )
          throw error;
        await this.recoverQuality(error);
        continue;
      }
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
  private async recoverQuality(error: unknown) {
    const previous = this.selectedQuality;
    const reason = error instanceof Error ? error.message : String(error);
    this.abr.quarantine(previous, performance.now(), reason);
    if (error instanceof EmergencySwitch)
      this.diagnostics.abrRecovery.aborted++;
    let index =
      error instanceof EmergencySwitch
        ? error.index
        : this.abr.fallback(this.qualityLevels, previous, performance.now());
    this.abrRecovering = true;
    try {
      while (index !== undefined) {
        const token = this.generation;
        try {
          const choice = this.qualityLevels[index];
          const parsed = await this.playlistLoader.rendition(
            choice.url,
            this.main!.playlist,
            0,
          );
          const playlist = alignRendition(parsed, this.main!.playlist);
          const next = this.main!.playlist.segments[this.main!.next];
          const boundary = Math.max(
            this.video.currentTime,
            next?.start ?? this.video.currentTime,
          );
          const lane = this.lane(playlist, 'main', choice.codecs);
          lane.next = Math.min(
            independentIndex(playlist, segmentAt(playlist, boundary)),
            playlist.segments.length - 1,
          );
          this.skipDeclaredGaps(lane);
          const prepared = await lane.prepare();
          if (token !== this.generation) return;
          this.assertLayout(prepared, lane);
          lane.inheritBuffer(this.main!);
          if (lane.buffer!.buffered.length) {
            const end = lane.buffer!.buffered.end(
              lane.buffer!.buffered.length - 1,
            );
            if (end > prepared.segment.start)
              await this.operation(lane.buffer!, () =>
                lane.buffer!.remove(prepared.segment.start, end),
              );
          }
          if (token !== this.generation) return;
          await this.appendPrepared(lane, prepared);
          if (token !== this.generation) return;
          lane.next++;
          this.main = lane;
          this.selectedQuality = index;
          this.qualityTimeline.push({ at: prepared.segment.start, id: index });
          this.abr.switched(performance.now());
          this.diagnostics.abrRecovery.failovers++;
          this.diagnostics.abrWarning = reason;
          this.emit('qualitychange', {
            ...choice,
            effectiveAt: prepared.segment.start,
            auto: true,
          });
          this.publishCatalog();
          return;
        } catch (failure) {
          this.abort.signal.throwIfAborted();
          this.abr.quarantine(
            index,
            performance.now(),
            failure instanceof Error ? failure.message : String(failure),
          );
          index = this.abr.fallback(
            this.qualityLevels,
            index,
            performance.now(),
          );
        }
      }
      throw error;
    } finally {
      this.abrRecovering = false;
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
      if (this.catalog.tracks.some((t: Track) => t.kind === 'video'))
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
    const p = alignRendition(
      await this.playlistLoader.rendition(choice.url, old.playlist),
      old.playlist,
    );
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
          Math.min(this.video.currentTime + lead, bufferedEnd - 0.26),
        ),
      );
      // Segment starts are rounded in playlists while AAC ends fall on frame
      // boundaries. Never drop the old lane with an unfilled interval before
      // the chosen switch, including switches across differently sized segments.
      const token = this.generation;
      while (
        old.next < old.playlist.segments.length &&
        old.playlist.segments[old.next].start < boundary &&
        this.video.currentTime + old.ahead(this.video.currentTime) <
          boundary - 0.05
      ) {
        const bridge = await old.prepare();
        if (token !== this.generation) break;
        await this.appendPrepared(old, bridge);
        old.next++;
      }
      if (token !== this.generation) continue;
      lane.next = segmentAt(p, boundary);
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
    this.abr.clear(index);
    this.emit('qualitychange', { auto: false });
    await this.enqueueSwitch('quality', index);
  }
  private updateDiagnostics() {
    this.diagnostics.playlistReload = this.playlistLoader.diagnostics;
    this.diagnostics.preload = this.playlistLoader.preload.diagnostics;
    this.diagnostics.quality = {
      mode: this.autoQuality ? 'auto' : 'manual',
      current: this.currentQuality,
      scheduled: this.selectedQuality,
      bandwidthEstimate: this.abr.estimate,
    };
    this.diagnostics.abrRecovery.quarantined = this.abr.quarantined(
      performance.now(),
    );
    this.diagnostics.bytes = this.client.bytes;
    this.diagnostics.requests = this.client.requests;
    this.diagnostics.retries = this.client.retries;
    this.diagnostics.buffer = {
      target: this.targetBuffer,
      mode: this.playlist?.partTarget ? 'll-hls-part' : 'hls-segment',
      holdBack:
        this.isLive && this.playlist ? holdBack(this.playlist) : undefined,
      latency:
        this.isLive && this.playlist
          ? Math.max(
              0,
              this.playlist.segments.at(-1)!.start +
                this.playlist.segments.at(-1)!.duration -
                this.video.currentTime,
            )
          : undefined,
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
    this.ttmlRenderer?.destroy();
    this.ttmlRenderer = undefined;
    this.vttStyles?.destroy();
    this.vttStyles = undefined;
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
      if (this.ttmlRenderer) return;
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

    if (track.format === 'cea-608') {
      abort.signal.addEventListener(
        'abort',
        () => this.abort.signal.removeEventListener('abort', stop),
        { once: true },
      );
      this.render608();
      return;
    }
    void (async () => {
      const client = new ResourceClient(
        this.source.network ?? {},
        abort.signal,
      );
      const seen = new Map<string, number>();
      const seenCues = new Map<string, number>();
      let initialization:
        | { key: string; metadata: ReturnType<typeof textMetadata> }
        | undefined;
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
            segment.gap ||
            seen.has(id) ||
            segment.start + segment.duration < time - 5 ||
            segment.start > time + this.targetBuffer
          )
            continue;
          const response = await client.get(segment);
          let data = response.data;
          if (segment.key)
            data = await this.decrypt(data, segment.key, segment.sequence);
          abort.signal.throwIfAborted();
          const offset =
            this.offsets.get(segment.discontinuity) ?? this.timelineOffset;
          let regions = new Map<string, VttRegionData>();
          let cues: ReturnType<typeof parseVtt> = [],
            documents: ReturnType<typeof parseTtml>[] = [];
          if (segment.map) {
            const key = JSON.stringify([segment.map, segment.key]);
            if (initialization?.key !== key) {
              let bytes = (await client.get(segment.map)).data;
              if (segment.key) {
                if (!segment.key.iv)
                  throw new Error(
                    'Encrypted subtitle initialization requires an explicit IV',
                  );
                bytes = await this.decrypt(
                  bytes,
                  segment.key,
                  segment.sequence,
                );
              }
              initialization = { key, metadata: textMetadata(bytes) };
            }
            const format =
              initialization.metadata[0].format === 'stpp' ? 'ttml' : 'webvtt';
            if (track.format !== format) {
              track.format = format;
              this.emit('subtitletracks', this.subtitleTracks);
              this.emit('subtitlechange', track);
            }
            ({ cues, documents } = textSamples(
              data,
              initialization.metadata,
              offset,
              segment.range?.offset ?? 0,
            ));
          } else {
            const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
            if (text.trimStart().startsWith('<'))
              documents = [
                parseTtml(
                  text,
                  segment.start,
                  segment.start + segment.duration,
                  0,
                ),
              ];
            else {
              cues = parseVtt(text, offset, this.video.currentTime);
              const headers = vttHeaders(text);
              regions = headers.regions;
              if (headers.styles.length) {
                this.vttStyles ??= new WebVttStyles(this.video);
                for (const style of headers.styles) this.vttStyles.add(style);
              }
            }
          }
          abort.signal.throwIfAborted();
          for (const doc of documents) {
            textTrack.mode = 'hidden';
            this.ttmlRenderer ??= new TtmlRenderer(this.video, (text) => {
              this.subtitleCounters.present(
                text ? { text, rects: [] } : null,
                !!text,
              );
              this.emit('subtitlemetrics', {
                received: this.subtitleCounters.received,
                displayed: this.subtitleCounters.displayed,
              });
            });
            this.ttmlRenderer.add(doc);
            for (const paragraph of doc.paragraphs) {
              if (paragraph.runs.some((run) => run.text.trim()))
                this.subtitleCounters.receive();
            }
          }
          for (const cue of cues) {
            const key = JSON.stringify(cue);
            if (seenCues.has(key)) continue;
            seenCues.set(key, cue.end);
            textTrack.addCue(nativeCue(cue, regions));
            this.subtitleCounters.receive();
          }
          for (const [key, end] of seenCues)
            if (end < this.video.currentTime - 30) seenCues.delete(key);
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
  private render608() {
    if (!this.textTrack) return;
    const service = Number(this.selectedSubtitle.replace('hls-608-', ''));
    const events = this.captions608.events.filter((e) => e.service === service);
    for (const cue of Array.from(this.textTrack.cues ?? []))
      this.textTrack.removeCue(cue);
    for (const [key, time] of this.captions608Seen)
      if (time < this.video.currentTime - 35) this.captions608Seen.delete(key);
    for (let i = 0; i < events.length; i++) {
      const event = events[i],
        end = events[i + 1]?.time ?? this.captions608.horizon;
      if (end <= Math.max(0, event.time) || end < this.video.currentTime - 35)
        continue;
      const key = JSON.stringify(event);
      if (!event.checkpoint && !this.captions608Seen.has(key)) {
        this.subtitleCounters.receive();
        this.captions608Seen.set(key, event.time);
      }
      for (const row of event.rows) {
        const cue = new VTTCue(Math.max(0, event.time), end, row608Text(row));
        cue.id = 'cea608';
        cue.snapToLines = false;
        cue.line = 10 + (row.row * 80) / 15;
        cue.lineAlign = 'start';
        cue.position = 10 + (row.column * 80) / 32;
        cue.positionAlign = 'line-left';
        cue.align = 'left';
        cue.size = ((32 - row.column) * 80) / 32;
        this.textTrack.addCue(cue);
      }
    }
  }
  seekToLive() {
    if (!this.isLive || !this.playlist) return;
    const p = this.playlist,
      last = p.segments.at(-1)!;
    this.video.currentTime = Math.max(
      p.segments[0].start,
      last.start + last.duration - holdBack(p),
    );
    void this.play();
  }
  async destroy() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    for (const request of this.switches.splice(0))
      request.reject(new DOMException('Player closed', 'AbortError'));
    this.subtitleAbort?.abort();
    this.ttmlRenderer?.destroy();
    this.ttmlRenderer = undefined;
    this.vttStyles?.destroy();
    this.vttStyles = undefined;
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
