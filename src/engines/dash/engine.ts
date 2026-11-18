import type { PlaybackEngine } from '../../core/player';
import { VERSION } from '../../version';
import { ResourceClient, delay, type NetworkOptions } from '../hls/network';
import { HttpError, retryable } from '../hls/recovery';
import { AbrController } from '../hls/abr';
import { bufferedAhead, nextGapPosition } from '../hls/buffer';
import { inspectInit, type Track } from '../hls/mp4';
import { EmeController, type DrmOptions } from '../hls/eme';
import type { Resource } from '../hls/playlist';
import { parseMpd } from './mpd';
import { initializationResource, segmentReferences } from './segments';
import { parseSidx } from './sidx';
import { mediaEvent } from './media';
import type {
  Adaptation,
  Manifest,
  Period,
  Representation,
  SegmentReference,
} from './model';
export interface DashSource {
  [key: string]: unknown;
  protocol: 'dash';
  url: string;
  network?: NetworkOptions;
  drm?: DrmOptions;
  autoplay?: boolean;
  startTime?: number;
  targetBuffer?: number;
  quality?: 'auto' | number;
  audioLanguage?: string;
  liveRecoveryWindowMs?: number;
}
interface Lane {
  adaptation: Adaptation;
  rep: Representation;
  period: Period;
  buffer?: SourceBuffer;
  mime: string;
  init: Uint8Array;
  tracks: Track[];
  cursor: number;
  done: boolean;
  needsPreroll: boolean;
  retryAt?: number;
  failureSince?: number;
  index?: SegmentReference[];
}
export class DashEngine extends EventTarget implements PlaybackEngine {
  readonly protocol = 'dash';
  readonly stack = 'ThePlayer DASH';
  readonly diagnostics = {
    version: VERSION,
    state: 'idle',
    objects: 0,
    bytes: 0,
    requests: 0,
    manifestUpdates: 0,
    clockOffset: 0,
    clockWarning: '',
    recovery: {
      manifestFailures: 0,
      segmentFailures: 0,
      dvrJumps: 0,
      expiredSegments: 0,
    },
    buffer: { ahead: 0, target: 12, live: false, mode: 'dash-segment' },
    quality: { mode: 'auto', current: 0, bandwidthEstimate: 0 },
    switches: [] as { kind: string; name: string; effectiveAt: number }[],
  };
  catalog: any = { profile: 'dash', tracks: [] };
  audioTracks: any[] = [];
  subtitleTracks: any[] = [];
  qualityLevels: any[] = [];
  selectedAudioTrack = '';
  selectedSubtitleTrack = '';
  selectedQuality = 0;
  autoQuality = true;
  isLive = false;
  mediaMode: 'video' | 'audio' = 'video';
  private manifest!: Manifest;
  private period!: Period;
  private lanes: Lane[] = [];
  private abort = new AbortController();
  private client: ResourceClient;
  private media?: MediaSource;
  private mediaUrl = '';
  private eme?: EmeController;
  private abr = new AbrController();
  private refreshedAt = 0;
  private manifestFailureSince?: number;
  private dvrJumpAt = -Infinity;
  private generation = 0;
  private seekPosition?: number;
  private initial = true;
  private ended = false;
  private failed = false;
  private startPosition = 0;
  private qualityTimeline: { at: number; index: number }[] = [];
  private commands: {
    kind: 'quality' | 'audio';
    index: number;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  private runner?: Promise<void>;
  private closing?: Promise<void>;
  constructor(
    readonly video: HTMLVideoElement,
    readonly source: DashSource,
  ) {
    super();
    if (!['http:', 'https:'].includes(new URL(source.url).protocol))
      throw new Error('DASH requires HTTP(S)');
    if (
      source.targetBuffer !== undefined &&
      (!Number.isFinite(source.targetBuffer) ||
        source.targetBuffer < 2 ||
        source.targetBuffer > 120)
    )
      throw new Error('Invalid DASH target buffer');
    if (
      source.startTime !== undefined &&
      (!Number.isFinite(source.startTime) || source.startTime < 0)
    )
      throw new Error('Invalid DASH start time');
    if (
      source.liveRecoveryWindowMs !== undefined &&
      (!Number.isFinite(source.liveRecoveryWindowMs) ||
        source.liveRecoveryWindowMs < 1000 ||
        source.liveRecoveryWindowMs > 120000)
    )
      throw new Error('Invalid DASH live recovery window');
    this.client = new ResourceClient(source.network ?? {}, this.abort.signal);
    this.autoQuality = typeof source.quality !== 'number';
    if (source.drm)
      this.eme = new EmeController(video, source.drm, (e) => this.fail(e));
    video.addEventListener(
      'seeking',
      () => {
        if (this.initial) return;
        this.generation++;
        this.seekPosition = video.currentTime;
        this.ended = false;
        for (const lane of this.lanes) {
          lane.cursor = this.prerollPosition(lane, video.currentTime);
          lane.needsPreroll = true;
          lane.failureSince = undefined;
          lane.retryAt = undefined;
          lane.done = false;
        }
      },
      { signal: this.abort.signal },
    );
    video.addEventListener(
      'error',
      () =>
        this.fail(new Error(video.error?.message ?? 'DASH media decode error')),
      { signal: this.abort.signal },
    );
    for (const [event, state] of [
      ['playing', 'playing'],
      ['waiting', 'buffering'],
      ['pause', 'paused'],
      ['ended', 'ended'],
    ])
      video.addEventListener(
        event,
        () => {
          if (!this.failed) this.state(state);
        },
        { signal: this.abort.signal },
      );
  }
  get targetBuffer() {
    return this.source.targetBuffer ?? 12;
  }
  get currentQuality() {
    return (
      this.qualityTimeline.findLast(
        (v) => v.at <= this.video.currentTime + 0.05,
      )?.index ?? this.selectedQuality
    );
  }
  private emit(name: string, detail: unknown) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
  private state(state: string) {
    this.diagnostics.state = state;
    this.emit('statechange', state);
  }
  private fail(error: unknown) {
    if (this.failed || this.abort.signal.aborted) return;
    if (error instanceof HttpError)
      error = new Error(`DASH HTTP ${error.status}`, { cause: error });
    this.failed = true;
    this.state('error');
    this.emit(
      'error',
      error instanceof Error ? error : new Error(String(error)),
    );
    for (const command of this.commands.splice(0)) command.reject(error);
  }
  private async readManifest(url: string, refresh = false) {
    const result = await this.client.get(
      { url },
      refresh ? this.liveRequestOptions(true) : {},
    );
    if (result.data.length > 4 * 1024 * 1024)
      throw new Error('DASH MPD exceeds 4 MiB');
    return parseMpd(
      new TextDecoder('utf-8', { fatal: true }).decode(result.data),
      result.url,
    );
  }
  private liveRequestOptions(manifest = false) {
    return {
      retries: 0,
      recoveryWindowMs: 0,
      timeoutMs: Math.min(
        this.source.network?.timeoutMs ?? (manifest ? 2000 : 15000),
        this.recoveryWindow,
      ),
    };
  }
  private get recoveryWindow() {
    return this.source.liveRecoveryWindowMs ?? 30000;
  }
  private windowStart() {
    return Math.min(
      this.edge(),
      Math.max(
        this.manifest.periods[0].start,
        this.edge() - (this.manifest.timeShiftBufferDepth ?? 300),
      ),
    );
  }
  private livePosition() {
    const start = this.windowStart();
    // Leave decode headroom inside short DVR windows instead of chasing
    // their moving lower boundary with repeated seeks.
    const floor = start + Math.min(2, (this.edge() - start) / 2);
    return Math.max(
      floor,
      this.edge() - (this.manifest.suggestedPresentationDelay ?? 12),
    );
  }
  private now() {
    return Date.now() / 1000 + this.diagnostics.clockOffset;
  }
  private edge() {
    return this.manifest.live
      ? Math.max(0, this.now() - this.manifest.availabilityStartTime!)
      : this.manifest.duration!;
  }
  private async syncClock() {
    for (const timing of this.manifest.utcTiming) {
      try {
        let time: number;
        const before = Date.now() / 1000;
        if (/urn:mpeg:dash:utc:direct:201[24]$/.test(timing.scheme))
          time = Date.parse(timing.value) / 1000;
        else if (
          /urn:mpeg:dash:utc:http-(xsdate|iso):201[24]$/.test(timing.scheme)
        ) {
          const response = await this.client.get({
            url: new URL(timing.value, this.manifest.url).href,
          });
          time =
            Date.parse(new TextDecoder().decode(response.data).trim()) / 1000;
        } else continue;
        if (!Number.isFinite(time))
          throw new Error('Invalid DASH UTC response');
        this.diagnostics.clockOffset = time - (before + Date.now() / 1000) / 2;
        return;
      } catch (e) {
        this.abort.signal.throwIfAborted();
        this.diagnostics.clockWarning =
          'DASH UTC synchronization failed; trying another source';
      }
    }
    if (this.manifest.utcTiming.length)
      this.diagnostics.clockWarning =
        'No usable DASH UTC timing source; using the local clock';
  }
  private periodAt(time: number) {
    return (
      this.manifest.periods.findLast((p) => p.start <= time + 0.001) ??
      this.manifest.periods[0]
    );
  }
  private usable(adaptation: Adaptation) {
    return adaptation.representations
      .filter(
        (r) =>
          r.mimeType.endsWith('/mp4') &&
          !!r.codecs &&
          MediaSource.isTypeSupported(`${r.mimeType}; codecs="${r.codecs}"`),
      )
      .sort((a, b) => a.bandwidth - b.bandwidth);
  }
  private inventory(period: Period) {
    const video = period.adaptations.find(
      (a) => a.kind === 'video' && this.usable(a).length,
    );
    const audio = period.adaptations.filter(
      (a) => a.kind === 'audio' && this.usable(a).length,
    );
    this.mediaMode = video ? 'video' : 'audio';
    const primary = video ?? audio[0];
    if (!primary)
      throw new Error('No supported DASH audio/video representation');
    this.qualityLevels = this.usable(primary).map((r, id) => ({
      ...r,
      id,
      representationId: r.id,
      resolution: r.width && r.height ? `${r.width}x${r.height}` : undefined,
      label: r.height
        ? `${r.height}p · ${(r.bandwidth / 1e6).toFixed(2)} Mb/s`
        : `${Math.round(r.bandwidth / 1000)} kb/s`,
    }));
    this.audioTracks = audio.map((a) => ({
      name: a.id,
      label: a.label,
      language: a.language,
      adaptation: a,
    }));
    this.subtitleTracks = [];
    this.emit('qualitylevels', this.qualityLevels);
    this.emit('subtitletracks', this.subtitleTracks);
    return { primary, video, audio };
  }
  private async makeLane(
    adaptation: Adaptation,
    rep: Representation,
    period: Period,
    cursor: number,
  ): Promise<Lane> {
    const response = await this.client.get(initializationResource(rep));
    const tracks = inspectInit(response.data);
    if (!tracks.length || tracks.some((t) => t.kind !== adaptation.kind))
      throw new Error('DASH initialization does not match its AdaptationSet');
    const mime = `${adaptation.kind}/mp4; codecs="${tracks.map((t) => t.codec).join(',')}"`;
    if (!MediaSource.isTypeSupported(mime))
      throw new Error('DASH codec is unavailable in this browser');
    const lane: Lane = {
      adaptation,
      rep,
      period,
      cursor,
      done: false,
      needsPreroll: true,
      mime,
      init: response.data,
      tracks,
    };
    if (rep.address.kind === 'base') {
      if (!rep.address.indexRange)
        throw new Error('DASH SegmentBase needs indexRange');
      const index = await this.client.get({
        url: rep.baseUrls[0],
        range: rep.address.indexRange,
      });
      lane.index = parseSidx(
        index.data,
        rep.address.indexRange.offset,
        index.url,
        rep,
        period,
      );
    }
    lane.cursor = this.prerollPosition(lane, cursor);
    return lane;
  }
  private prerollPosition(lane: Lane, time: number) {
    const a = lane.rep.address;
    const duration =
      lane.index?.reduce((max, s) => Math.max(max, s.end - s.start), 0) ||
      a.timeline?.reduce(
        (max, s) => Math.max(max, Number(s.duration) / a.timescale),
        0,
      ) ||
      Number(a.duration ?? BigInt(a.timescale * 2)) / a.timescale;
    return Math.max(
      lane.period.start,
      this.isLive ? this.windowStart() : 0,
      time - duration,
    );
  }
  private async protect(lanes: Lane[]) {
    const tracks = lanes.flatMap((l) => l.tracks);
    if (!tracks.some((t) => t.encryption)) return;
    if (!this.eme) throw new Error('Encrypted DASH requires drm configuration');
    await this.eme.ensure(tracks);
    for (const lane of lanes)
      for (const protection of lane.rep.protection)
        for (const pssh of protection.pssh)
          await this.eme.requestInitData(pssh);
    if (this.source.drm?.clearKeys) await this.eme.requestKeyIds(tracks);
  }
  private async configure(lane: Lane, previous?: Lane) {
    if (previous) {
      lane.buffer = previous.buffer;
      if (previous.mime !== lane.mime) {
        // AVC resolution/level changes are conveyed by the new avcC init.
        // WebKit may support those without implementing changeType.
        const compatibleAvc =
          previous.tracks.length === lane.tracks.length &&
          lane.tracks.every(
            (track, i) =>
              /^avc[13]\./.test(track.codec) &&
              track.codec.slice(0, 9) === previous.tracks[i].codec.slice(0, 9),
          );
        if (!lane.buffer?.changeType && !compatibleAvc)
          throw new Error('DASH codec changes require SourceBuffer.changeType');
        lane.buffer?.changeType?.(lane.mime);
      }
    } else if (!lane.buffer) {
      try {
        lane.buffer = this.media!.addSourceBuffer(lane.mime);
      } catch (error) {
        throw new Error(
          `DASH SourceBuffer ${lane.mime} (${this.media!.sourceBuffers.length} existing): ${(error as Error).message}`,
        );
      }
    }
    const buffer = lane.buffer!;
    buffer.appendWindowStart = 0;
    buffer.appendWindowEnd =
      lane.period.duration === undefined
        ? Infinity
        : lane.period.start + lane.period.duration;
    buffer.appendWindowStart = lane.period.start;
    const offset =
      lane.period.start -
      Number(lane.rep.address.presentationTimeOffset) /
        lane.rep.address.timescale;
    if (buffer.timestampOffset !== offset) buffer.timestampOffset = offset;
    await mediaEvent(buffer, 'updateend', this.abort.signal, () =>
      buffer.appendBuffer(lane.init as BufferSource),
    );
  }
  private async enterPeriod(period: Period, cursor: number, initial = false) {
    const { primary, video, audio } = this.inventory(period);
    const reps = this.usable(primary);
    let index =
      initial && typeof this.source.quality === 'number'
        ? this.source.quality
        : Math.min(this.selectedQuality, reps.length - 1);
    if (!Number.isInteger(index) || !reps[index])
      throw new Error('Unknown DASH quality');
    const selectedAudio =
      audio.find((a) => a.id === this.selectedAudioTrack) ??
      audio.find(
        (a) =>
          this.source.audioLanguage &&
          a.language.toLowerCase() === this.source.audioLanguage.toLowerCase(),
      ) ??
      audio.find((a) => a.roles.includes('main')) ??
      audio[0];
    const initialPrimary = video ? primary : selectedAudio!;
    const primaryReps = this.usable(initialPrimary);
    index = Math.min(index, primaryReps.length - 1);
    const lanes = [
      await this.makeLane(initialPrimary, primaryReps[index], period, cursor),
    ];
    if (video && selectedAudio)
      lanes.push(
        await this.makeLane(
          selectedAudio,
          this.usable(selectedAudio)[0],
          period,
          cursor,
        ),
      );
    await this.protect(lanes);
    if (
      this.lanes.length &&
      (lanes.length !== this.lanes.length ||
        lanes.some(
          (l) =>
            !this.lanes.some(
              (old) => old.adaptation.kind === l.adaptation.kind,
            ),
        ))
    )
      throw new Error('DASH Period track topology changes are not implemented');
    if (!this.lanes.length) {
      for (const lane of lanes)
        lane.buffer = this.media!.addSourceBuffer(lane.mime);
    }
    for (const lane of lanes)
      await this.configure(
        lane,
        this.lanes.find((l) => l.adaptation.kind === lane.adaptation.kind),
      );
    this.period = period;
    this.lanes = lanes;
    this.selectedQuality = index;
    this.selectedAudioTrack = selectedAudio?.id ?? '';
    this.qualityTimeline.push({ at: cursor, index });
    this.qualityTimeline = this.qualityTimeline.slice(-100);
    this.emit(
      'audiochange',
      this.audioTracks.find((a) => a.name === this.selectedAudioTrack) ?? null,
    );
    this.catalog = {
      profile: 'dash',
      tracks: lanes.flatMap((l) => l.tracks),
      period: period.id,
    };
    this.emit('catalog', this.catalog);
  }
  async init() {
    this.state('loading');
    if (!globalThis.MediaSource) throw new Error('DASH requires MediaSource');
    this.manifest = await this.readManifest(this.source.url);
    this.isLive = this.manifest.live;
    await this.syncClock();
    if (!this.isLive && !Number.isFinite(this.manifest.duration))
      throw new Error(
        'Static DASH MPD must declare a finite presentation duration',
      );
    const edge = this.edge();
    const delay =
      this.manifest.suggestedPresentationDelay ??
      Math.max(12, 3 * this.manifest.minBufferTime);
    this.startPosition =
      this.source.startTime ??
      (this.isLive
        ? Math.max(this.windowStart(), edge - delay)
        : this.manifest.periods[0].start);
    if (!this.isLive)
      this.startPosition = Math.min(
        this.startPosition,
        Math.max(0, this.manifest.duration! - 0.001),
      );
    this.media = new MediaSource();
    this.mediaUrl = URL.createObjectURL(this.media);
    await mediaEvent(this.media, 'sourceopen', this.abort.signal, () => {
      this.video.src = this.mediaUrl;
    });
    this.media.duration = this.isLive ? Infinity : this.manifest.duration!;
    await this.enterPeriod(
      this.periodAt(this.startPosition),
      this.startPosition,
      true,
    );
    this.refreshedAt = performance.now();
    this.emit('streamchange', { live: this.isLive });
    this.runner = this.run().catch((e) => this.fail(e));
  }
  private references(lane: Lane, from: number) {
    let to = from + Math.max(60, this.targetBuffer * 2);
    if (this.isLive)
      to = Math.min(
        to,
        this.edge() +
          (lane.rep.address.availabilityTimeComplete
            ? lane.rep.address.availabilityTimeOffset
            : 0),
      );
    const references =
      lane.index ?? segmentReferences(lane.rep, lane.period, from, to);
    return references.filter(
      (r) => r.end > from + 0.005 && (!this.isLive || r.end <= to + 0.001),
    );
  }
  private async refresh() {
    if (!this.isLive || this.manifest.minimumUpdatePeriod === undefined) return;
    const interval = Math.max(500, this.manifest.minimumUpdatePeriod * 1000);
    if (performance.now() - this.refreshedAt < interval) return;
    let next: Manifest;
    try {
      next = await this.readManifest(
        this.manifest.locations[0] ?? this.manifest.url,
        true,
      );
      this.manifestFailureSince = undefined;
    } catch (error) {
      this.abort.signal.throwIfAborted();
      if (!retryable(error)) throw error;
      this.manifestFailureSince ??= performance.now();
      this.diagnostics.recovery.manifestFailures++;
      this.refreshedAt = performance.now();
      if (performance.now() - this.manifestFailureSince >= this.recoveryWindow)
        throw new Error('DASH live manifest recovery window exhausted', {
          cause: error,
        });
      return;
    }
    if (
      next.availabilityStartTime !== undefined &&
      next.availabilityStartTime !== this.manifest.availabilityStartTime
    )
      throw new Error('DASH availabilityStartTime changed');
    if (
      this.manifest.publishTime &&
      next.publishTime &&
      next.publishTime < this.manifest.publishTime
    ) {
      this.refreshedAt = performance.now();
      return;
    }
    const period = next.periods.find((p) => p.id === this.period.id);
    if (period) {
      if (period.start !== this.period.start)
        throw new Error('DASH Period start changed');
      for (const lane of this.lanes) {
        const adaptation = period.adaptations.find(
          (a) => a.id === lane.adaptation.id,
        );
        const rep = adaptation?.representations.find(
          (r) => r.id === lane.rep.id,
        );
        if (!adaptation || !rep)
          throw new Error('Active DASH representation disappeared');
        if (
          rep.address.presentationTimeOffset !==
            lane.rep.address.presentationTimeOffset ||
          rep.address.timescale !== lane.rep.address.timescale
        )
          throw new Error('DASH representation clock changed');
        lane.rep = rep;
        lane.period = period;
        lane.adaptation = adaptation;
      }
      this.period = period;
    }
    this.manifest = next;
    this.refreshedAt = performance.now();
    this.diagnostics.manifestUpdates++;
    if (this.isLive !== next.live) {
      this.isLive = next.live;
      this.media!.duration = next.live ? Infinity : next.duration!;
      this.emit('streamchange', { live: this.isLive });
    }
  }
  private async append(
    lane: Lane,
    segment: SegmentReference,
    data?: Uint8Array,
  ) {
    const generation = this.generation;
    let response;
    try {
      response = data
        ? undefined
        : await this.client.get(
            segment,
            this.isLive ? this.liveRequestOptions() : {},
          );
    } catch (error) {
      this.abort.signal.throwIfAborted();
      if (generation !== this.generation) return;
      if (
        !this.isLive ||
        (!retryable(error) &&
          !(
            error instanceof HttpError &&
            error.status === 410 &&
            segment.end <= this.windowStart()
          ))
      )
        throw error;
      this.diagnostics.recovery.segmentFailures++;
      if (segment.end <= this.windowStart()) {
        lane.cursor = this.windowStart();
        lane.failureSince = undefined;
        this.diagnostics.recovery.expiredSegments++;
        return;
      }
      lane.failureSince ??= performance.now();
      if (performance.now() - lane.failureSince >= this.recoveryWindow)
        throw new Error('DASH live segment recovery window exhausted', {
          cause: error,
        });
      lane.retryAt = performance.now() + 500;
      return;
    }
    lane.failureSince = undefined;
    lane.retryAt = undefined;
    if (generation !== this.generation) return;
    if (response) this.abr.observe(response.data.length, response.elapsed);
    await mediaEvent(lane.buffer!, 'updateend', this.abort.signal, () =>
      lane.buffer!.appendBuffer((data ?? response!.data) as BufferSource),
    );
    if (generation === this.generation) {
      lane.cursor = segment.end;
      lane.needsPreroll = false;
    }
    this.diagnostics.objects++;
    const start = this.video.buffered.length ? this.video.buffered.start(0) : 0;
    await this.eme?.retainKeys(lane.tracks, segment.end, start);
  }
  private updateDiagnostics() {
    this.diagnostics.bytes = this.client.bytes;
    this.diagnostics.requests = this.client.requests;
    this.diagnostics.buffer = {
      ahead: bufferedAhead(this.video.buffered, this.video.currentTime),
      target: this.targetBuffer,
      live: this.isLive,
      mode: 'dash-segment',
    };
    this.diagnostics.quality = {
      mode: this.autoQuality ? 'auto' : 'manual',
      current: this.currentQuality,
      bandwidthEstimate: this.abr.estimate,
    };
  }
  private async run() {
    while (!this.abort.signal.aborted && !this.failed) {
      await this.refresh();
      if (
        this.isLive &&
        !this.initial &&
        !this.video.paused &&
        (!this.video.seeking || performance.now() - this.dvrJumpAt >= 2000) &&
        this.video.currentTime < this.windowStart() - 0.5
      ) {
        this.dvrJumpAt = performance.now();
        this.diagnostics.recovery.dvrJumps++;
        this.video.currentTime = this.livePosition();
        await delay(0, this.abort.signal);
      }
      if (this.commands.length) {
        const command = this.commands.shift()!;
        try {
          await this.switchLane(command.kind, command.index);
          command.resolve();
        } catch (e) {
          command.reject(e);
        }
        continue;
      }
      if (this.seekPosition !== undefined) {
        const position = this.seekPosition;
        this.seekPosition = undefined;
        const period = this.periodAt(position);
        if (period.id !== this.period.id)
          await this.enterPeriod(period, position);
      }
      if (this.initial && this.video.buffered.length) {
        const b = this.video.buffered;
        const index =
          Array.from({ length: b.length }, (_, i) => i).find(
            (i) => b.end(i) > this.startPosition,
          ) ?? 0;
        this.video.currentTime = Math.max(
          b.start(index) + 0.001,
          Math.min(this.startPosition, b.end(index) - 0.001),
        );
        this.initial = false;
        if (this.source.autoplay !== false) void this.play();
      }
      this.updateDiagnostics();
      const gap = nextGapPosition(this.video.buffered, this.video.currentTime);
      if (!this.video.paused && this.video.readyState < 3 && gap !== undefined)
        this.video.currentTime = gap;
      if (this.isLive) {
        const edge = this.edge();
        this.media!.setLiveSeekableRange(
          Math.max(
            this.manifest.periods[0].start,
            edge - (this.manifest.timeShiftBufferDepth ?? 300),
          ),
          edge,
        );
      }
      if (this.autoQuality && !this.initial && !this.video.paused) {
        const index = this.abr.choose(
          this.qualityLevels,
          this.selectedQuality,
          this.diagnostics.buffer.ahead,
          this.targetBuffer,
          performance.now(),
        );
        if (index !== this.selectedQuality) {
          try {
            await this.switchLane('quality', index);
          } catch (e) {
            this.abr.quarantine(index, performance.now(), 'DASH switch failed');
          }
        }
      }
      let appended = false;
      for (const lane of this.lanes) {
        if (
          lane.done ||
          (lane.retryAt !== undefined && performance.now() < lane.retryAt) ||
          (!lane.needsPreroll &&
            bufferedAhead(lane.buffer!.buffered, this.video.currentTime) >=
              this.targetBuffer)
        )
          continue;
        const reference = this.references(lane, lane.cursor)[0];
        if (reference) {
          await this.append(lane, reference);
          appended = true;
        } else if (
          lane.period.duration !== undefined &&
          lane.cursor >= lane.period.start + lane.period.duration - 0.05
        )
          lane.done = true;
        const removeBefore = this.video.currentTime - 30;
        if (
          removeBefore > 0 &&
          lane.buffer!.buffered.length &&
          lane.buffer!.buffered.start(0) < removeBefore - 5
        )
          await mediaEvent(lane.buffer!, 'updateend', this.abort.signal, () =>
            lane.buffer!.remove(0, removeBefore),
          );
      }
      if (this.lanes.every((l) => l.done)) {
        const next =
          this.manifest.periods[
            this.manifest.periods.findIndex((p) => p.id === this.period.id) + 1
          ];
        if (next) {
          await this.enterPeriod(next, next.start);
          continue;
        }
        if (
          !this.isLive &&
          !this.ended &&
          this.media?.readyState === 'open' &&
          !this.video.seeking
        ) {
          this.media.endOfStream();
          this.ended = true;
        }
      }
      if (!appended) await delay(100, this.abort.signal);
    }
  }
  private async switchLane(kind: 'quality' | 'audio', index: number) {
    const old =
      kind === 'quality'
        ? this.lanes[0]
        : this.lanes.find((l) => l.adaptation.kind === 'audio');
    if (!old) throw new Error('DASH media lane is unavailable');
    const adaptation =
      kind === 'quality' ? old.adaptation : this.audioTracks[index]?.adaptation;
    if (!adaptation) throw new Error('Unknown DASH audio track');
    const rep = this.usable(adaptation)[kind === 'quality' ? index : 0];
    if (!rep) throw new Error('Unknown DASH quality');
    if (rep.id === old.rep.id && adaptation.id === old.adaptation.id) return;
    const generation = this.generation;
    const lane = await this.makeLane(adaptation, rep, this.period, old.cursor);
    let reference = this.references(lane, old.cursor)[0];
    const deadline = performance.now() + 15000;
    while (!reference && this.isLive && performance.now() < deadline) {
      await delay(200, this.abort.signal);
      if (generation !== this.generation)
        throw new Error('DASH seek interrupted switching');
      await this.refresh();
      const updated = this.period.adaptations
        .find((a) => a.id === adaptation.id)
        ?.representations.find((r) => r.id === rep.id);
      if (updated) lane.rep = updated;
      reference = this.references(lane, old.cursor)[0];
    }
    if (!reference || reference.start > old.cursor + 0.05)
      throw new Error('DASH rendition has no aligned switching segment');
    const media = await this.client.get(reference);
    await this.protect([lane, ...this.lanes.filter((l) => l !== old)]);
    if (generation !== this.generation)
      throw new Error('DASH seek interrupted switching');
    await this.configure(lane, old);
    await this.append(lane, reference, media.data);
    this.lanes[this.lanes.indexOf(old)] = lane;
    if (kind === 'quality') {
      this.selectedQuality = index;
      this.qualityTimeline.push({ at: reference.start, index });
      this.qualityTimeline = this.qualityTimeline.slice(-100);
      this.abr.switched(performance.now());
      this.emit('qualitychange', {
        ...this.qualityLevels[index],
        effectiveAt: reference.start,
      });
    } else {
      this.selectedAudioTrack = adaptation.id;
      this.emit('audiochange', this.audioTracks[index]);
    }
    this.diagnostics.switches.push({
      kind,
      name: kind === 'quality' ? String(index) : adaptation.id,
      effectiveAt: reference.start,
    });
    this.diagnostics.switches = this.diagnostics.switches.slice(-20);
  }
  async selectQuality(index: number) {
    if (index === -1) {
      this.autoQuality = true;
      this.emit('qualitychange', { auto: true });
      return;
    }
    if (!Number.isInteger(index) || !this.qualityLevels[index])
      throw new Error('Unknown DASH quality');
    this.autoQuality = false;
    await this.enqueue('quality', index);
  }
  async selectAudioTrack(name: string) {
    const index = this.audioTracks.findIndex((t) => t.name === name);
    if (index < 0) throw new Error('Unknown DASH audio track');
    await this.enqueue('audio', index);
  }
  private enqueue(kind: 'quality' | 'audio', index: number): Promise<void> {
    if (this.failed || this.abort.signal.aborted)
      return Promise.reject(new Error('DASH engine is not active'));
    return new Promise((resolve, reject) =>
      this.commands.push({ kind, index, resolve, reject }),
    );
  }
  selectSubtitleTrack(name: string) {
    if (name) throw new Error('DASH subtitle selection is not implemented yet');
    this.selectedSubtitleTrack = '';
    this.emit('subtitlechange', null);
  }
  seekToLive() {
    if (this.isLive) {
      this.video.currentTime = this.livePosition();
      void this.play();
    }
  }
  async play() {
    try {
      await this.video.play();
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError')
        this.emit('autoplayblocked', null);
      else if (!this.abort.signal.aborted && (e as Error).name !== 'AbortError')
        this.fail(e);
    }
  }
  destroy(): Promise<void> {
    return (this.closing ??= (async () => {
      this.abort.abort(new DOMException('DASH player destroyed', 'AbortError'));
      for (const command of this.commands.splice(0))
        command.reject(this.abort.signal.reason);
      await this.runner;
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
      await this.eme?.destroy();
      this.lanes = [];
      this.state('destroyed');
    })());
  }
}
export type { DrmOptions } from '../hls/eme';
