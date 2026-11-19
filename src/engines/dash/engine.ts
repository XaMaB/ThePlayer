import {
  createMediaSource,
  mediaSourceConstructor,
  supportsMediaType,
  releaseMediaSource,
} from '../../core/media-source';
import { ChunkThroughput } from './chunk-throughput';
import { PlaybackMetrics } from './qoe';
import type { CmcdOptions } from './telemetry';
import { DashThumbnails } from './thumbnails';
import { producerClocks, type ProducerClock } from './producer-time';
import type { PlaybackEngine } from '../../core/player';
import { VERSION } from '../../version';
import { delay, type NetworkOptions } from '../hls/network';
import { HttpError, retryable } from '../hls/recovery';
import { AbrController, type AbrOptions } from '../hls/abr';
import { bufferedAhead, nextGapPosition } from '../hls/buffer';
import { emsgMetadata, type TimedMetadata } from '../hls/metadata';
import { inspectInit, decodeTime, type Track } from '../hls/mp4';
import { EmeController, type DrmOptions } from '../hls/eme';
import type { Resource } from '../hls/playlist';
import { parseMpd } from './mpd';
import { initializationResource, segmentReferences } from './segments';
import { RemoteElements } from './xlink';
import { DashResourceClient } from './network';
import { DashCaptions } from './captions';
import type { FragmentTrack } from '../hls/fragment-samples';
import type { P16Encoding } from '../hls/cea708-packets';
import { applyMpdPatch } from './patch';
import { CmafChunks } from './chunks';
import { DashSubtitles, textFormat } from './subtitles';
import { loadSidx } from './sidx';
import { mediaEvent } from './media';
import type {
  Adaptation,
  DashEvent,
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
  abr?: AbrOptions;
  audioLanguage?: string;
  audioRole?: string;
  cmcd?: CmcdOptions;
  liveRecoveryWindowMs?: number;
  lowLatency?: boolean;
  latencyControl?: boolean;
  useMpdPatch?: boolean;
  captionEncodings?: Record<number, P16Encoding>;
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
  captionMetadata?: FragmentTrack[];
  producerClock?: ProducerClock;
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
    metadataEvents: 0,
    xlink: { requests: 0, resolved: 0, fallbacks: 0, removed: 0 },
    patches: { applied: 0, fallbacks: 0 },
    delivery: { switches: 0, failures: 0, origin: '' },
    clockOffset: 0,
    clockWarning: '',
    lowLatency: {
      chunks: 0,
      throughputSamples: 0,
      latency: 0,
      target: 0,
      playbackRate: 1,
      producerLatency: null as number | null,
      producerType: '',
      producerSource: '',
    },
    recovery: {
      manifestFailures: 0,
      segmentFailures: 0,
      dvrJumps: 0,
      expiredSegments: 0,
      manifestTransitions: 0,
      restarts: 0,
      lastRestart: '',
      seekRetries: 0,
    },
    buffer: { ahead: 0, target: 12, live: false, mode: 'dash-segment' },
    qoe: {} as Record<string, unknown>,
    steering: {} as Record<string, unknown>,
    quality: {
      mode: 'auto',
      current: 0,
      bandwidthEstimate: 0,
      abr: undefined as Readonly<Required<AbrOptions>> | undefined,
    },
    switches: [] as { kind: string; name: string; effectiveAt: number }[],
  };
  catalog: any = { profile: 'dash', tracks: [] };
  videoTracks: any[] = [];
  selectedVideoTrack = '';
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
  private manifestXml = '';
  private metadataSeen = new Map<string, number>();
  private period!: Period;
  private lanes: Lane[] = [];
  private abort = new AbortController();
  private client: DashResourceClient;
  private metrics: PlaybackMetrics;
  private lastQoeAt = 0;
  private presentedPeriod = '';
  private thumbnails?: DashThumbnails;
  private remote: RemoteElements;
  private media?: MediaSource;
  private mediaUrl = '';
  private eme?: EmeController;
  private subtitles?: DashSubtitles;
  private captions: DashCaptions;
  private subtitleGeneration = 0;
  private abr: AbrController;
  private refreshedAt = 0;
  private manifestFailureSince?: number;
  private dvrJumpAt = -Infinity;
  private generation = 0;
  private seekPosition?: number;
  private pendingSeek?: { position: number; started: number; retried: boolean };
  private retrySeekTarget?: number;
  private initial = true;
  private startupSeek?: number;
  private controlledRate = 1;
  private resumeAfterStart?: boolean;
  private restartTimes: number[] = [];
  private ended = false;
  private failed = false;
  private startPosition = 0;
  private qualityTimeline: { at: number; index: number }[] = [];
  private commands: {
    kind: 'quality' | 'audio' | 'view';
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
    this.abr = new AbrController(source.abr);
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
    this.captions = new DashCaptions(
      video,
      source.captionEncodings,
      (event, detail) => {
        if (event === 'captiontracks') {
          this.subtitleTracks = [
            ...this.subtitleTracks.filter((t) => !t.inband),
            ...this.captions.tracks,
          ];
          this.emit('subtitletracks', this.subtitleTracks);
        } else this.emit(event, detail);
      },
    );
    this.metrics = new PlaybackMetrics(video, this.abort.signal);
    this.client = new DashResourceClient(
      source.network ?? {},
      this.abort.signal,
    );
    if (source.cmcd)
      this.client.telemetry = {
        options: source.cmcd,
        metrics: () => ({
          live: this.manifest?.live,
          buffer: bufferedAhead(video.buffered, video.currentTime),
          throughput: this.abr.estimate,
          startup: this.initial,
        }),
      };
    this.remote = new RemoteElements(this.client);
    this.autoQuality = typeof source.quality !== 'number';
    if (source.drm)
      this.eme = new EmeController(video, source.drm, (e) => this.fail(e));
    video.addEventListener(
      'seeking',
      () => {
        if (this.initial) return;
        if (this.startupSeek !== undefined) {
          const internal = Math.abs(video.currentTime - this.startupSeek) < 0.1;
          this.startupSeek = undefined;
          if (internal) return;
        }
        if (
          this.retrySeekTarget !== undefined &&
          Math.abs(video.currentTime - this.retrySeekTarget) < 0.01
        ) {
          this.retrySeekTarget = undefined;
          return;
        }
        this.retrySeekTarget = undefined;
        this.pendingSeek = {
          position: video.currentTime,
          started: performance.now(),
          retried: false,
        };
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
      'seeked',
      () => {
        this.pendingSeek = undefined;
        this.retrySeekTarget = undefined;
      },
      { signal: this.abort.signal },
    );
    video.addEventListener('timeupdate', () => this.updateLatency(), {
      signal: this.abort.signal,
    });
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
    const result = await this.client.manifest(
      url,
      refresh ? this.liveRequestOptions(true) : {},
      this.manifest?.locations.includes(url)
        ? {
            url,
            alternatives: this.manifest.locations.filter((u) => u !== url),
            serviceLocations: [
              this.manifest.locationServices?.[
                this.manifest.locations.indexOf(url)
              ] ?? '',
              ...this.manifest.locations.flatMap((u, i) =>
                u !== url ? [this.manifest.locationServices?.[i] ?? ''] : [],
              ),
            ],
          }
        : undefined,
    );
    if (result.data.length > 4 * 1024 * 1024)
      throw new Error('DASH MPD exceeds 4 MiB');
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(result.data);
    const resolved = await this.remote.resolve(
      xml,
      result.url,
      this.manifest ? this.video.currentTime : this.source.startTime,
    );
    const parsed = parseMpd(resolved, result.url);
    this.client.configure(parsed);
    if (!this.manifest) await this.client.steering?.refresh(false, 0);
    this.manifestXml = xml;
    return parsed;
  }
  private async readUpdate() {
    const location = this.manifest.patchLocations?.find(
      (p) =>
        p.ttl === undefined ||
        (this.manifest.publishTime !== undefined &&
          this.now() <= this.manifest.publishTime + p.ttl),
    );
    if (location && this.source.useMpdPatch !== false && this.manifestXml) {
      try {
        const response = await this.client.get(
          { url: location.url },
          this.liveRequestOptions(true),
        );
        const patched = applyMpdPatch(
          this.manifestXml,
          new TextDecoder('utf-8', { fatal: true }).decode(response.data),
        );
        const next = parseMpd(
          await this.remote.resolve(
            patched,
            this.manifest.url,
            this.video.currentTime,
          ),
          this.manifest.url,
        );
        this.client.configure(next);
        this.manifestXml = patched;
        this.diagnostics.patches.applied++;
        return next;
      } catch (error) {
        this.abort.signal.throwIfAborted();
        this.diagnostics.patches.fallbacks++;
      }
    }
    return this.readManifest(
      this.manifest.locations[0] ?? this.manifest.url,
      true,
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
      this.edge() -
        (this.manifest.service?.targetLatency ??
          this.manifest.suggestedPresentationDelay ??
          12),
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
          supportsMediaType(`${r.mimeType}; codecs="${r.codecs}"`),
      )
      .sort((a, b) => a.bandwidth - b.bandwidth);
  }
  private inventory(period: Period) {
    const videos = period.adaptations.filter(
      (a) => a.kind === 'video' && this.usable(a).length,
    );
    const video =
      videos.find((a) => a.id === this.selectedVideoTrack) ?? videos[0];
    this.videoTracks = videos.map((a) => ({
      name: a.id,
      label: a.label,
      adaptation: a,
    }));
    this.selectedVideoTrack = video?.id ?? '';
    this.emit('videotracks', this.videoTracks);
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
      roles: a.roles,
      accessibility: a.accessibility,
      channels: a.representations[0]?.channels,
      adaptation: a,
    }));
    this.subtitleTracks = period.adaptations
      .filter(
        (a) =>
          a.kind === 'text' && a.representations.some((r) => textFormat(r)),
      )
      .map((a) => ({
        name: a.id,
        label: a.label,
        language: a.language,
        format: textFormat(a.representations[0]),
        adaptation: a,
        period,
      }));
    this.subtitleTracks.push(...this.captions.tracks);
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
    if (!supportsMediaType(mime))
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
      captionMetadata:
        adaptation.kind === 'video' && !tracks.some((t) => t.encryption)
          ? this.captions.metadata(response.data)
          : undefined,
    };
    if (rep.address.kind === 'base') {
      if (!rep.address.indexRange)
        throw new Error('DASH SegmentBase needs indexRange');
      const index = await this.client.get({
        url: rep.baseUrls[0],
        alternatives: rep.baseUrls.slice(1),
        range: rep.address.indexRange,
        serviceLocations: rep.serviceLocations,
      });
      lane.index = (
        await loadSidx(
          this.client,
          index.data,
          rep.address.indexRange.offset,
          index.url,
          rep,
          period,
        )
      ).map((reference) => ({
        ...reference,
        telemetry: {
          type: adaptation.kind === 'audio' ? ('a' as const) : ('v' as const),
          duration: reference.end - reference.start,
          bitrate: rep.bandwidth,
        },
        alternatives: rep.baseUrls.filter((url) => url !== reference.url),
        serviceLocations: [
          rep.serviceLocations?.[rep.baseUrls.indexOf(reference.url)] ?? '',
          ...rep.baseUrls.flatMap((url, i) =>
            url !== reference.url ? [rep.serviceLocations?.[i] ?? ''] : [],
          ),
        ],
      }));
    }
    lane.cursor = this.prerollPosition(lane, cursor);
    return lane;
  }
  private prerollPosition(lane: Lane, time: number) {
    const a = lane.rep.address;
    if (!a.availabilityTimeComplete)
      return Math.max(
        lane.period.start,
        this.isLive ? this.windowStart() : 0,
        time - 0.001,
      );
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
    const system = this.source.drm?.keySystem;
    const scheme =
      system === 'com.widevine.alpha'
        ? 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'
        : system === 'com.microsoft.playready'
          ? 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'
          : system === 'org.w3.clearkey'
            ? 'urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b'
            : undefined;
    for (const lane of lanes)
      for (const protection of lane.rep.protection) {
        if (
          scheme &&
          protection.scheme.toLowerCase().startsWith('urn:uuid:') &&
          protection.scheme.toLowerCase() !== scheme
        )
          continue;
        for (const pssh of protection.pssh)
          await this.eme.requestInitData(pssh);
      }
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
    if (period.remote) {
      const resolved = parseMpd(
        await this.remote.resolve(
          this.manifestXml,
          this.manifest.url,
          cursor,
          false,
        ),
        this.manifest.url,
      );
      this.manifest = resolved;
      period = this.periodAt(cursor);
      if (period.remote)
        throw new Error(
          'DASH remote Period is unavailable at playback position',
        );
    }
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
          languageMatches(a.language, this.source.audioLanguage) &&
          (!this.source.audioRole || a.roles.includes(this.source.audioRole)),
      ) ??
      audio.find(
        (a) => this.source.audioRole && a.roles.includes(this.source.audioRole),
      ) ??
      audio.find((a) => a.roles.includes('main')) ??
      audio[0];
    const initialPrimary = video ? primary : selectedAudio!;
    const primaryReps = this.usable(initialPrimary);
    index =
      initial && this.autoQuality
        ? this.abr.initialIndex(primaryReps)
        : Math.min(index, primaryReps.length - 1);
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
      return this.restart(this.manifest, cursor, 'track-topology');
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
    this.manifestEvents(period);
  }
  async init() {
    this.state('loading');
    mediaSourceConstructor();
    this.manifest = await this.readManifest(this.source.url);
    this.isLive = this.manifest.live;
    await this.syncClock();
    if (!this.isLive && !Number.isFinite(this.manifest.duration))
      throw new Error(
        'Static DASH MPD must declare a finite presentation duration',
      );
    const edge = this.edge();
    const delay =
      this.manifest.service?.targetLatency ??
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
    this.media = createMediaSource(this.video);
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
  private async restart(
    manifest: Manifest,
    position: number | undefined,
    reason: string,
  ): Promise<void> {
    const now = performance.now();
    this.restartTimes = this.restartTimes.filter((t) => t > now - 30000);
    if (this.restartTimes.length >= 3)
      throw new Error('DASH source repeatedly reset its timeline');
    this.restartTimes.push(now);
    this.resumeAfterStart =
      this.resumeAfterStart ??
      (this.initial ? this.source.autoplay !== false : !this.video.paused);
    const subtitle = this.selectedSubtitleTrack;
    this.generation++;
    this.initial = true;
    this.ended = false;
    this.seekPosition = undefined;
    this.pendingSeek = undefined;
    this.retrySeekTarget = undefined;
    await this.subtitles?.destroy();
    this.subtitles = undefined;
    this.captions.reset();
    this.metadataSeen.clear();
    this.manifest = manifest;
    this.isLive = manifest.live;
    await this.syncClock();
    this.startPosition =
      position ??
      (manifest.live ? this.livePosition() : manifest.periods[0].start);
    this.lanes = [];
    this.qualityTimeline = [];
    const previousUrl = this.mediaUrl;
    this.media = createMediaSource(this.video);
    this.mediaUrl = URL.createObjectURL(this.media);
    await mediaEvent(this.media, 'sourceopen', this.abort.signal, () => {
      this.video.src = this.mediaUrl;
    });
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    this.media.duration = this.isLive ? Infinity : manifest.duration!;
    await this.enterPeriod(
      this.periodAt(this.startPosition),
      this.startPosition,
    );
    if (subtitle && this.subtitleTracks.some((t) => t.name === subtitle))
      await this.selectSubtitleTrack(subtitle);
    this.refreshedAt = performance.now();
    this.diagnostics.recovery.restarts++;
    this.diagnostics.recovery.lastRestart = reason;
    this.emit('streamchange', { live: this.isLive });
  }
  private references(lane: Lane, from: number) {
    let to = from + Math.max(60, this.targetBuffer * 2);
    if (this.isLive)
      to = Math.min(to, this.edge() + lane.rep.address.availabilityTimeOffset);
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
    const previousXml = this.manifestXml;
    try {
      next = await this.readUpdate();
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
      this.manifest.publishTime &&
      next.publishTime &&
      next.publishTime < this.manifest.publishTime
    ) {
      this.refreshedAt = performance.now();
      this.manifestXml = previousXml;
      return;
    }
    if (
      next.availabilityStartTime !== undefined &&
      next.availabilityStartTime !== this.manifest.availabilityStartTime
    )
      return this.restart(next, undefined, 'availability-start-time');
    const period = next.periods.find((p) => p.id === this.period.id);
    if (
      period &&
      period.adaptations.some(
        (a) =>
          (a.kind === 'audio' || a.kind === 'video') &&
          this.usable(a).length &&
          !this.lanes.some((l) => l.adaptation.kind === a.kind),
      )
    )
      return this.restart(next, this.video.currentTime, 'track-topology');
    const missing =
      !period ||
      this.lanes.some(
        (lane) =>
          !period.adaptations
            .find((a) => a.id === lane.adaptation.id)
            ?.representations.some((r) => r.id === lane.rep.id),
      );
    if (period && !missing) {
      if (period.start !== this.period.start)
        return this.restart(next, undefined, 'period-start');
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
          return this.restart(next, undefined, 'representation-clock');
        lane.rep = rep;
        lane.period = period;
        lane.adaptation = adaptation;
      }
      this.period = period;
    }
    this.manifest = next;
    if (missing) {
      const oldPrimary = this.lanes[0];
      const oldAudio = this.lanes.find((l) => l.adaptation.kind === 'audio');
      const position = Math.max(this.video.currentTime, this.windowStart());
      const replacement = period ?? this.periodAt(position);
      const primary = replacement.adaptations.find(
        (a) => a.kind === oldPrimary.adaptation.kind && this.usable(a).length,
      );
      if (!primary)
        throw new Error('DASH update has no compatible media adaptation');
      const representations = this.usable(primary);
      const same = representations.findIndex((r) => r.id === oldPrimary.rep.id);
      this.selectedQuality =
        same >= 0
          ? same
          : Math.max(
              0,
              representations.findLastIndex(
                (r) => r.bandwidth <= oldPrimary.rep.bandwidth,
              ),
            );
      if (
        oldAudio &&
        !replacement.adaptations.some((a) => a.id === this.selectedAudioTrack)
      )
        this.selectedAudioTrack =
          replacement.adaptations.find(
            (a) =>
              a.kind === 'audio' && a.language === oldAudio.adaptation.language,
          )?.id ?? '';
      await this.enterPeriod(replacement, position);
      this.qualityTimeline = [{ at: position, index: this.selectedQuality }];
      if (!this.video.paused && this.video.currentTime < replacement.start)
        this.video.currentTime = Math.max(position, replacement.start);
      this.diagnostics.recovery.manifestTransitions++;
    } else if (period) {
      const selectedId = this.lanes[0].rep.id;
      const previousLevels = this.qualityLevels;
      this.inventory(period);
      this.selectedQuality = Math.max(
        0,
        this.qualityLevels.findIndex((r) => r.representationId === selectedId),
      );
      this.qualityTimeline = this.qualityTimeline.map((entry) => ({
        at: entry.at,
        index: Math.max(
          0,
          this.qualityLevels.findIndex(
            (r) =>
              r.representationId ===
              previousLevels[entry.index]?.representationId,
          ),
        ),
      }));
    }
    this.refreshedAt = performance.now();
    this.diagnostics.manifestUpdates++;
    this.manifestEvents(this.period);
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
    const chunked =
      !data &&
      this.source.lowLatency !== false &&
      this.source.network?.transport !== 'xhr' &&
      !lane.rep.address.availabilityTimeComplete &&
      !segment.range;
    const chunks = chunked ? new CmafChunks() : undefined;
    const transfer = new ChunkThroughput();
    let work: Promise<void> = Promise.resolve();
    let appendError: unknown;
    let units = 0;
    const onChunk = chunks
      ? (bytes: Uint8Array) => {
          const complete = chunks.push(bytes);
          transfer.observe(
            bytes.length,
            complete.reduce((n, u) => n + u.length, 0),
            performance.now(),
          );
          for (const unit of complete) {
            work = work
              .then(async () => {
                if (
                  appendError ||
                  generation !== this.generation ||
                  this.abort.signal.aborted
                )
                  return;
                await mediaEvent(
                  lane.buffer!,
                  'updateend',
                  this.abort.signal,
                  () => lane.buffer!.appendBuffer(unit as BufferSource),
                );
                if (lane.captionMetadata)
                  this.captions.consume(
                    unit,
                    lane.captionMetadata,
                    lane.period.start -
                      Number(lane.rep.address.presentationTimeOffset) /
                        lane.rep.address.timescale,
                    lane.period.id,
                  );
                this.fragmentEvents(unit, lane);
                units++;
                this.diagnostics.lowLatency.chunks++;
                this.startPlayback();
              })
              .catch((error) => {
                appendError = error;
              });
          }
        }
      : undefined;
    let response;
    try {
      response = data
        ? undefined
        : await this.client.get(segment, {
            ...(this.isLive ? this.liveRequestOptions() : {}),
            onChunk,
          });
    } catch (error) {
      await work;
      if (appendError) throw appendError;
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
    await work;
    if (appendError) throw appendError;
    chunks?.finish();
    lane.failureSince = undefined;
    lane.retryAt = undefined;
    if (generation !== this.generation) return;
    if (response) {
      this.abr.observe(
        transfer.samples ? transfer.bytes : response.data.length,
        transfer.samples ? transfer.elapsed : response.elapsed,
      );
      this.diagnostics.lowLatency.throughputSamples += transfer.samples;
    }
    if (!units)
      await mediaEvent(lane.buffer!, 'updateend', this.abort.signal, () =>
        lane.buffer!.appendBuffer((data ?? response!.data) as BufferSource),
      );
    if (!units) this.fragmentEvents(data ?? response!.data, lane);
    if (!units && lane.captionMetadata)
      this.captions.consume(
        data ?? response!.data,
        lane.captionMetadata,
        lane.period.start -
          Number(lane.rep.address.presentationTimeOffset) /
            lane.rep.address.timescale,
        lane.period.id,
        segment.range?.offset ?? 0,
      );
    this.startPlayback();
    if (generation === this.generation) {
      lane.cursor = segment.end;
      lane.needsPreroll = false;
    }
    this.diagnostics.objects++;
    const start = this.video.buffered.length ? this.video.buffered.start(0) : 0;
    await this.eme?.retainKeys(lane.tracks, segment.end, start);
  }
  private metadataEvent(
    event: (TimedMetadata | DashEvent) & { lane?: string },
    period: string,
  ) {
    const data =
      typeof event.data === 'string'
        ? event.data
        : new TextDecoder().decode(event.data ?? new Uint8Array());
    if (data.length > 65536 || String(event.scheme).length > 2048) return;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++)
      hash = Math.imul(hash ^ data.charCodeAt(i), 16777619);
    const key = JSON.stringify([
      period,
      event.scheme,
      event.value,
      event.id,
      event.time,
      event.duration,
      hash,
    ]);
    if (this.metadataSeen.has(key)) return;
    this.metadataSeen.set(key, event.time);
    for (const [id, time] of this.metadataSeen)
      if (time < this.video.currentTime - 35) this.metadataSeen.delete(id);
    while (this.metadataSeen.size > 1000)
      this.metadataSeen.delete(this.metadataSeen.keys().next().value!);
    this.diagnostics.metadataEvents++;
    this.emit('metadata', { ...event, period });
    if (event.scheme === 'urn:mpeg:dash:event:2012') this.refreshedAt = 0;
  }
  private manifestEvents(period: Period) {
    for (const event of period.events ?? [])
      this.metadataEvent(event, period.id);
  }
  private fragmentEvents(data: Uint8Array, lane: Lane) {
    try {
      const signaled = lane.rep.producerReferences?.find(
        (ref) =>
          ref.inband &&
          (this.manifest?.service?.referenceId === undefined
            ? ref.type === 'encoder'
            : ref.id === this.manifest.service.referenceId),
      );
      for (const clock of producerClocks(data, lane.tracks, this.now())) {
        if (clock.type === (signaled?.type ?? 'encoder'))
          lane.producerClock = clock;
      }
      const offset =
        lane.period.start -
        Number(lane.rep.address.presentationTimeOffset) /
          lane.rep.address.timescale;
      for (const event of emsgMetadata(data, () =>
        decodeTime(data, lane.tracks),
      ))
        this.metadataEvent(
          { ...event, time: event.time + offset, lane: lane.adaptation.kind },
          lane.period.id,
        );
    } catch (error) {
      this.emit(
        'metadatawarning',
        new Error('DASH emsg metadata could not be decoded', { cause: error }),
      );
    }
  }
  private startPlayback() {
    if (this.initial && this.video.buffered.length) {
      const b = this.video.buffered;
      const index = Array.from({ length: b.length }, (_, i) => i).find(
        (i) => b.end(i) > this.startPosition,
      );
      if (index === undefined) return;
      this.startupSeek = Math.max(
        b.start(index) + 0.001,
        Math.min(this.startPosition, b.end(index) - 0.001),
      );
      this.pendingSeek = {
        position: this.startupSeek,
        started: performance.now(),
        retried: false,
      };
      this.video.currentTime = this.startupSeek;
      this.initial = false;
      const resume = this.resumeAfterStart ?? this.source.autoplay !== false;
      this.resumeAfterStart = undefined;
      if (resume) void this.play();
    }
  }
  private updateLatency() {
    if (!this.manifest || !this.isLive) return;
    const service = this.manifest.service;
    const target =
      service?.targetLatency ?? this.manifest.suggestedPresentationDelay ?? 12;
    const playbackPeriod = this.periodAt(this.video.currentTime);
    const primary =
      playbackPeriod.adaptations.find(
        (a) => a.kind === 'video' && a.id === this.selectedVideoTrack,
      ) ??
      playbackPeriod.adaptations.find((a) => a.kind === 'video') ??
      playbackPeriod.adaptations.find(
        (a) => a.kind === 'audio' && a.id === this.selectedAudioTrack,
      ) ??
      playbackPeriod.adaptations.find((a) => a.kind === 'audio');
    const representation =
      primary?.representations.find(
        (r) =>
          r.id === this.qualityLevels[this.currentQuality]?.representationId,
      ) ?? primary?.representations[0];
    const producer = representation?.producerReferences?.find((ref) =>
      service?.referenceId === undefined
        ? ref.type === 'encoder'
        : ref.id === service.referenceId,
    );
    const inband = this.lanes.find(
      (lane) =>
        lane.period.id === playbackPeriod.id &&
        lane.rep.id === representation?.id,
    )?.producerClock;
    const producerLatency =
      inband && representation
        ? this.now() -
          (inband.wallClockTime +
            this.video.currentTime -
            playbackPeriod.start -
            (inband.mediaTime -
              Number(representation.address.presentationTimeOffset) /
                representation.address.timescale))
        : producer && representation
          ? this.now() -
            (producer.wallClockTime +
              this.video.currentTime -
              playbackPeriod.start -
              Number(
                producer.presentationTime -
                  representation.address.presentationTimeOffset,
              ) /
                representation.address.timescale)
          : null;
    this.diagnostics.lowLatency.producerLatency = producerLatency;
    this.diagnostics.lowLatency.producerType =
      inband?.type ?? producer?.type ?? '';
    this.diagnostics.lowLatency.producerSource = inband
      ? 'inband'
      : producer
        ? 'mpd'
        : '';
    const latency = Math.max(
      0,
      producerLatency ?? this.edge() - this.video.currentTime,
    );
    this.diagnostics.lowLatency.latency = latency;
    this.diagnostics.lowLatency.target = target;
    if (
      this.source.latencyControl &&
      !this.initial &&
      !this.video.paused &&
      !this.video.seeking &&
      this.video.playbackRate === this.controlledRate
    ) {
      const reserve = bufferedAhead(
        this.video.buffered,
        this.video.currentTime,
      );
      const rate =
        reserve < 0.5
          ? 1
          : latency > target + 0.3
            ? (service?.maxRate ?? 1.03)
            : latency < target - 0.3
              ? (service?.minRate ?? 0.97)
              : 1;
      this.video.playbackRate = rate;
      this.controlledRate = rate;
    }
    this.diagnostics.lowLatency.playbackRate = this.video.playbackRate;
  }
  private updateDiagnostics() {
    this.diagnostics.qoe = this.metrics.snapshot();
    const presented = this.periodAt(this.video.currentTime);
    if (presented.id !== this.presentedPeriod) {
      const previousId = this.presentedPeriod;
      this.presentedPeriod = presented.id;
      this.emit('periodchange', {
        id: presented.id,
        previousId,
        start: presented.start,
        duration: presented.duration,
        time: this.video.currentTime,
      });
    }
    if (performance.now() - this.lastQoeAt >= 1000) {
      this.lastQoeAt = performance.now();
      this.emit('qoe', {
        ...this.diagnostics.qoe,
        time: this.video.currentTime,
        buffer: bufferedAhead(this.video.buffered, this.video.currentTime),
        quality: this.currentQuality,
      });
    }

    this.diagnostics.steering = this.client.steering?.diagnostics ?? {};
    this.diagnostics.delivery = { ...this.client.delivery };
    this.diagnostics.xlink = { ...this.remote.diagnostics };
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
      abr: this.abr.options,
    };
  }
  private recoverBufferedSeek() {
    const seek = this.pendingSeek;
    if (
      !seek ||
      seek.retried ||
      !this.video.seeking ||
      this.video.readyState < 2 ||
      performance.now() - seek.started < 1000 ||
      this.lanes.some((l) => l.needsPreroll || l.buffer?.updating)
    )
      return;
    const ranges = this.video.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (
        seek.position < ranges.start(i) ||
        seek.position + 0.05 >= ranges.end(i)
      )
        continue;
      // WebKit can keep an MSE seek pending during startup or after native
      // TextTrack changes. Reissue once, only for buffered
      // decoded media. The 1 ms change makes it a distinct browser operation.
      seek.retried = true;
      this.retrySeekTarget = seek.position + 0.001;
      this.diagnostics.recovery.seekRetries++;
      this.video.currentTime = this.retrySeekTarget;
      return;
    }
  }
  private async run() {
    while (!this.abort.signal.aborted && !this.failed) {
      await this.refresh();
      await this.client.steering?.refresh(
        !this.initial &&
          bufferedAhead(this.video.buffered, this.video.currentTime) >=
            this.targetBuffer,
        this.abr.estimate,
      );
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
      this.startPlayback();
      this.updateDiagnostics();
      this.recoverBufferedSeek();
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
      // A new initialization segment must not race an unfinished startup/user seek.
      if (
        this.autoQuality &&
        !this.initial &&
        !this.video.paused &&
        !this.video.seeking
      ) {
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
      const results = await Promise.allSettled(
        this.lanes.map(async (lane) => {
          if (
            lane.done ||
            (lane.retryAt !== undefined && performance.now() < lane.retryAt) ||
            (!lane.needsPreroll &&
              bufferedAhead(lane.buffer!.buffered, this.video.currentTime) >=
                this.targetBuffer)
          )
            return;
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
        }),
      );
      for (const result of results)
        if (result.status === 'rejected') throw result.reason;

      if (this.lanes.every((l) => l.done)) {
        const next =
          this.manifest.periods[
            this.manifest.periods.findIndex((p) => p.id === this.period.id) + 1
          ];
        if (next) {
          await this.enterPeriod(next, next.start);
          continue;
        }
        if (!this.isLive && !this.ended && this.media?.readyState === 'open') {
          // EOS is safe while seeking: every final-Period lane has completed
          // and all append promises have settled.
          this.media.endOfStream();
          this.ended = true;
        }
      }
      if (!appended) await delay(100, this.abort.signal);
    }
  }
  private async switchLane(kind: 'quality' | 'audio' | 'view', index: number) {
    const old =
      kind === 'quality' || kind === 'view'
        ? this.lanes[0]
        : this.lanes.find((l) => l.adaptation.kind === 'audio');
    if (!old) throw new Error('DASH media lane is unavailable');
    const adaptation =
      kind === 'quality'
        ? old.adaptation
        : kind === 'view'
          ? this.videoTracks[index]?.adaptation
          : this.audioTracks[index]?.adaptation;
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
      await this.client.steering?.refresh(
        !this.initial &&
          bufferedAhead(this.video.buffered, this.video.currentTime) >=
            this.targetBuffer,
        this.abr.estimate,
      );
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
    } else if (kind === 'view') {
      this.selectedVideoTrack = adaptation.id;
      this.selectedQuality = 0;
      this.inventory(this.period);
      this.qualityTimeline.push({ at: reference.start, index: 0 });
      this.qualityTimeline = this.qualityTimeline.slice(-100);
      this.emit('videochange', {
        ...this.videoTracks[index],
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
  async selectVideoTrack(name: string) {
    const index = this.videoTracks.findIndex((t) => t.name === name);
    if (index < 0) throw new Error('Unknown DASH video view');
    await this.enqueue('view', index);
  }
  async selectAudioTrack(name: string) {
    const index = this.audioTracks.findIndex((t) => t.name === name);
    if (index < 0) throw new Error('Unknown DASH audio track');
    await this.enqueue('audio', index);
  }
  private enqueue(
    kind: 'quality' | 'audio' | 'view',
    index: number,
  ): Promise<void> {
    if (this.failed || this.abort.signal.aborted)
      return Promise.reject(new Error('DASH engine is not active'));
    return new Promise((resolve, reject) =>
      this.commands.push({ kind, index, resolve, reject }),
    );
  }
  async selectSubtitleTrack(name: string) {
    const selected = this.subtitleTracks.find((t) => t.name === name);
    if (name && !selected) throw new Error('Unknown DASH subtitle track');
    const generation = ++this.subtitleGeneration;
    await this.subtitles?.destroy();
    if (generation !== this.subtitleGeneration || this.abort.signal.aborted)
      return;
    this.subtitles = undefined;
    this.selectedSubtitleTrack = name;
    this.captions.select(selected?.inband ? name : '');
    if (selected && !selected.inband)
      this.subtitles = new DashSubtitles(
        this.video,
        selected.adaptation,
        () =>
          this.manifest
            ? this.periodAt(this.video.currentTime)
            : selected.period,
        this.source.network,
        (event, detail) => this.emit(event, detail),
      );
    this.emit('subtitlechange', selected ?? null);
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
  getThumbnail(time: number) {
    this.thumbnails ??= new DashThumbnails(this.client, () => this.manifest);
    return this.thumbnails.get(time);
  }
  destroy(): Promise<void> {
    this.thumbnails?.destroy();
    return (this.closing ??= (async () => {
      this.abort.abort(new DOMException('DASH player destroyed', 'AbortError'));
      for (const command of this.commands.splice(0))
        command.reject(this.abort.signal.reason);
      await this.runner;
      this.subtitleGeneration++;
      await this.subtitles?.destroy();
      this.captions.destroy();
      this.video.pause();
      this.video.removeAttribute('src');
      this.video.load();
      releaseMediaSource(this.video);
      if (this.mediaUrl) URL.revokeObjectURL(this.mediaUrl);
      await this.eme?.destroy();
      if (this.video.playbackRate === this.controlledRate)
        this.video.playbackRate = 1;
      this.lanes = [];
      this.state('destroyed');
    })());
  }
}
export type { DrmOptions } from '../hls/eme';

function languageMatches(language: string, preference: string) {
  const canonical = (value: string) => {
    try {
      return new Intl.Locale(value).language;
    } catch {
      return value.toLowerCase().split('-')[0];
    }
  };
  return canonical(language) === canonical(preference);
}
