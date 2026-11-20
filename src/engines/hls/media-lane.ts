import { supportsMediaType } from '../../core/media-source';
import { normalizeVideoSampleEntries } from './sample-entry';
import { packedAc3 } from './packed-ac3';
import { packedAudioKind, packedMp3 } from './packed-mp3';
import { isId3 } from './id3';
import { packedAac } from './packed-audio';
import { emsgMetadata, filterEmsg, type TimedMetadata } from './metadata';
import { fragmentSamples } from './fragment-samples';
import { extract708 } from './c708-mp4';
import { mp4SeiCaptions, type CcData } from './cea-sei';
import { captionMetadata, extract608, type CaptionPacket } from './c608-mp4';
import {
  filterCaptionInit,
  filterCaptionMedia,
  type IgnoredCaptionTrack,
} from './caption-tracks';
import { bufferedAhead } from './buffer';
import type { Playlist, Segment, Key, Resource } from './playlist';
import { TsTransmuxer, demux, unwrap, type Pes } from './transport-stream';
import {
  inspectInit,
  decodeTime,
  initialization,
  fragment,
  concat,
  type Track,
} from './mp4';

export interface LoadedResource {
  data: Uint8Array;
  url: string;
  elapsed: number;
}
export interface PreparedSegment {
  resourceOffset?: number;
  mime?: string;
  metadata: TimedMetadata[];
  metadataError?: string;
  segment: Segment;
  init: Uint8Array;
  data: Uint8Array;
  tracks: Track[];
  rawStart: number;
  /** Native MPEG timestamp rollover period, when the input uses a 33-bit clock. */
  timestampWrap?: number;
  bytes: number;
  elapsed: number;
  ignoredCaptions: IgnoredCaptionTrack[];
  captionPackets: CaptionPacket[];
  captionError?: string;
  digitalPackets: CcData[];
}
/** Each independently loaded rendition owns one SourceBuffer and decoder configuration. */
export class MediaLane {
  buffer?: SourceBuffer;
  tracks: Track[] = [];
  codec = '';
  offset = 0;
  discontinuity = -1;
  next = 0;
  refreshedAt = performance.now();
  private decoder: TsTransmuxer;
  private packedClock?: number;
  private packedSerial = 0;
  private mime = '';
  private captionMeta: ReturnType<typeof captionMetadata> = [];
  private captionMetaError?: string;
  private preparedDiscontinuity = -1;
  private ignoredCaptions: IgnoredCaptionTrack[] = [];
  private rawInitCache?: { key: string; data: Uint8Array };
  private initCache?: { key: string; data: Uint8Array };
  private appendedInit?: Uint8Array;
  constructor(
    public playlist: Playlist,
    readonly role: 'main' | 'audio',
    private readonly load: (resource: Resource) => Promise<LoadedResource>,
    private readonly decrypt: (
      data: Uint8Array,
      key: Key | undefined,
      sequence: number,
    ) => Promise<Uint8Array>,
    audioCodec?: string,
    private readonly decryptSamples?: (
      pes: Pes[],
      key: Key,
      sequence: number,
    ) => Promise<Pes[]>,
  ) {
    this.decoder = new TsTransmuxer(audioCodec);
  }
  ahead(time: number) {
    return this.buffer ? bufferedAhead(this.buffer.buffered, time) : 0;
  }

  async prepare(index = this.next): Promise<PreparedSegment> {
    const segment = this.playlist.segments[index];
    if (!segment || segment.gap)
      throw new Error('Missing segment or unsupported HLS GAP');
    const response = await this.load(segment);
    let data = ['SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(
      segment.key?.method ?? '',
    )
      ? response.data
      : await this.decrypt(response.data, segment.key, segment.sequence);
    if (this.preparedDiscontinuity !== segment.discontinuity) {
      this.decoder.reset();
      this.packedClock = undefined;
      this.preparedDiscontinuity = segment.discontinuity;
    }
    let mapBytes: Uint8Array | undefined;
    if (segment.map) {
      const mapKey = JSON.stringify(segment.map);
      if (this.rawInitCache?.key !== mapKey) {
        if (segment.map.key?.method === 'AES-128' && !segment.map.key.iv)
          throw new Error('Encrypted initialization needs an explicit IV');
        const loaded = await this.load(segment.map);
        mapBytes = ['SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(
          segment.map.key?.method ?? '',
        )
          ? loaded.data
          : await this.decrypt(loaded.data, segment.map.key, segment.sequence);
        this.rawInitCache = { key: mapKey, data: mapBytes };
      } else mapBytes = this.rawInitCache.data;
    }
    const tsInitialization = mapBytes?.[0] === 0x47 && data[0] === 0x47;
    if (tsInitialization) data = concat(mapBytes!, data);
    let init: Uint8Array,
      tracks: Track[],
      rawStart: number,
      timestampWrap: number | undefined,
      mime: string | undefined;
    let digitalPackets: CcData[] = [];
    let metadata: TimedMetadata[] = [];
    let metadataError: string | undefined;
    let captionPackets: CaptionPacket[] = [],
      captionError: string | undefined = this.captionMetaError;
    if (segment.map && !tsInitialization) {
      const key = JSON.stringify(segment.map);
      if (this.initCache?.key !== key) {
        const original = mapBytes!;
        const filtered = filterCaptionInit(original);
        this.captionMeta = [];
        this.captionMetaError = undefined;
        {
          try {
            this.captionMeta = captionMetadata(original);
          } catch (error) {
            this.captionMetaError =
              error instanceof Error ? error.message : String(error);
          }
        }
        captionError = this.captionMetaError;
        this.ignoredCaptions = filtered.ignored;
        this.initCache = {
          key,
          data: normalizeVideoSampleEntries(filtered.data),
        };
      }
      init = this.initCache.data;
      try {
        captionPackets = extract608(
          data,
          this.captionMeta,
          segment.range?.offset ?? 0,
        );
      } catch (error) {
        captionError = error instanceof Error ? error.message : String(error);
      }
      try {
        const inBand = mp4SeiCaptions(
          data,
          this.captionMeta,
          segment.range?.offset ?? 0,
        );
        const cdp = extract708(
          data,
          this.captionMeta,
          segment.range?.offset ?? 0,
        );
        const hasDigitalTrack = this.captionMeta.some(
          (t) => t.format === 'c708',
        );
        const hasAnalogTrack = this.captionMeta.some(
          (t) => t.format === 'c608',
        );
        const packets = [
          ...inBand.filter((p) =>
            p.type < 2 ? !hasAnalogTrack && !hasDigitalTrack : !hasDigitalTrack,
          ),
          ...cdp.filter((p) => p.type >= 2 || !hasAnalogTrack),
        ];
        captionPackets.push(
          ...packets
            .filter((p) => p.type < 2)
            .map((p) => ({
              time: p.time,
              first: p.first,
              second: p.second,
              field: (p.type + 1) as 1 | 2,
            })),
        );
        digitalPackets = packets.filter((p) => p.type >= 2);
      } catch (error) {
        captionError = error instanceof Error ? error.message : String(error);
      }
      data = filterCaptionMedia(
        data,
        this.ignoredCaptions,
        this.captionMeta,
        segment.range?.offset ?? 0,
      );
      tracks = inspectInit(init);
      if (
        segment.key?.method === 'SAMPLE-AES' ||
        segment.key?.method === 'SAMPLE-AES-CTR'
      ) {
        const expected = segment.key.method === 'SAMPLE-AES' ? 'cbcs' : 'cenc';
        if (
          !tracks.some((t) => t.encryption) ||
          tracks.some((t) => t.encryption && t.encryption.scheme !== expected)
        )
          throw new Error(
            'HLS key method does not match fMP4 protection scheme',
          );
      }
      rawStart = decodeTime(data, tracks);
      try {
        metadata = emsgMetadata(data, () => {
          const samples = fragmentSamples(
            data,
            this.captionMeta,
            segment.range?.offset ?? 0,
          );
          const earliest = samples.reduce(
            (time, sample) => Math.min(time, sample.time),
            Infinity,
          );
          return Number.isFinite(earliest) ? earliest : rawStart;
        });
      } catch (error) {
        metadataError = error instanceof Error ? error.message : String(error);
      }
      data = filterEmsg(data);
    } else if (isId3(data) && packedAudioKind(data) === 'mp3') {
      if (
        segment.key?.method === 'SAMPLE-AES' ||
        segment.key?.method === 'SAMPLE-AES-CTR'
      )
        throw new Error('SAMPLE-AES does not define MP3 encryption');
      const packed = packedMp3(data);
      const timestamp = unwrap(
        packed.timestamp,
        this.packedClock ?? packed.timestamp,
      );
      this.packedClock = timestamp;
      rawStart = timestamp / 90000;
      timestampWrap = 2 ** 33 / 90000;
      tracks = [packed.track];
      data = packed.data;
      init = new Uint8Array();
      if (supportsMediaType('audio/mpeg')) mime = 'audio/mpeg';
      else {
        init = initialization(tracks);
        data = fragment(
          packed.track,
          packed.samples,
          (timestamp * packed.track.timescale) / 90000,
          ++this.packedSerial,
        );
      }
      metadata = packed.metadata.map((item) => ({
        ...item,
        time: unwrap(item.time * 90000, timestamp) / 90000,
      }));
    } else if (data[0] === 0x47 || isId3(data)) {
      if (segment.key?.method === 'SAMPLE-AES-CTR')
        throw new Error('SAMPLE-AES-CTR requires fMP4');
      const packed = isId3(data)
        ? packedAudioKind(data) === 'ac3'
          ? packedAc3(data)
          : packedAac(data)
        : undefined;
      const pes = packed?.pes ?? demux(data);
      const encrypted = segment.key?.method === 'SAMPLE-AES';
      if (encrypted && !this.decryptSamples)
        throw new Error('SAMPLE-AES decoder unavailable');
      const result = this.decoder.transmuxPes(
        encrypted
          ? await this.decryptSamples!(pes, segment.key!, segment.sequence)
          : pes,
        segment.duration,
      );
      init = result.init;
      tracks = result.tracks;
      data = result.media;
      rawStart = result.start;
      timestampWrap = 2 ** 33 / 90000;
      metadataError = result.metadataError;
      metadata = (packed?.metadata ?? result.metadata).map((item) => ({
        ...item,
        time: unwrap(item.time * 90000, result.start * 90000) / 90000,
      }));
      captionPackets = result.captions
        .filter((p) => p.type < 2)
        .map((p) => ({
          time: p.time,
          first: p.first,
          second: p.second,
          field: (p.type + 1) as 1 | 2,
        }));
      digitalPackets = result.captions.filter((p) => p.type >= 2);
      captionError = result.captionError;
    } else
      throw new Error(
        'Expected MPEG-TS, timestamped packed audio, or fMP4 with EXT-X-MAP',
      );
    if (this.role === 'audio' && tracks.some((t) => t.kind !== 'audio'))
      throw new Error('Audio rendition contains a non-audio track');
    return {
      resourceOffset:
        segment.map && !tsInitialization ? (segment.range?.offset ?? 0) : 0,
      segment,
      mime,
      metadata,
      metadataError,
      init,
      data,
      tracks,
      rawStart,
      timestampWrap,
      bytes: response.data.length,
      elapsed: response.elapsed,
      ignoredCaptions: this.ignoredCaptions,
      captionPackets,
      digitalPackets,
      captionError,
    };
  }
  configure(media: MediaSource, prepared: PreparedSegment) {
    const codec = prepared.tracks.map((t) => t.codec).join(','),
      mime =
        prepared.mime ??
        `${prepared.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio'}/mp4; codecs="${codec}"`;
    if (!supportsMediaType(mime))
      throw new Error('Unsupported browser codec: ' + codec);
    if (!this.buffer) {
      this.buffer = media.addSourceBuffer(mime);
      this.buffer.mode = mime === 'audio/mpeg' ? 'sequence' : 'segments';
    } else if (this.mime !== mime) {
      if (typeof this.buffer.changeType === 'function') {
        this.buffer.changeType(mime);
      } else {
        // AVC level changes carry their new SPS/PPS in the next init segment.
        // Older WebKit MSE has no changeType; allow only an unchanged sample
        // entry, profile and constraints, with all other tracks identical.
        const withoutAvcLevel = (value: string) =>
          value.replace(/\b(avc[13]\.[0-9a-f]{4})[0-9a-f]{2}\b/gi, '$1');
        if (withoutAvcLevel(this.mime) !== withoutAvcLevel(mime))
          throw new Error(
            'This browser cannot switch SourceBuffer codec types',
          );
      }
      this.appendedInit = undefined;
      this.buffer.mode = mime === 'audio/mpeg' ? 'sequence' : 'segments';
    }
    this.mime = mime;
    this.codec = codec;
    this.tracks = prepared.tracks;
  }
  async append(
    prepared: PreparedSegment,
    offset: number,
    operation: (buffer: SourceBuffer, action: () => void) => Promise<void>,
  ) {
    this.offset = offset;
    const timestampOffset =
      prepared.mime === 'audio/mpeg' ? prepared.rawStart + offset : offset;
    // Even assigning the current value invokes MSE's parser-state checks.
    // A browser may retain a media-segment parser state across append calls.
    if (this.buffer!.timestampOffset !== timestampOffset)
      this.buffer!.timestampOffset = timestampOffset;
    const previous = this.appendedInit;
    if (
      prepared.init.length &&
      (!previous ||
        previous.length !== prepared.init.length ||
        previous.some((value, i) => value !== prepared.init[i]))
    ) {
      await operation(this.buffer!, () =>
        this.buffer!.appendBuffer(prepared.init as BufferSource),
      );
      this.appendedInit = prepared.init;
    }
    await operation(this.buffer!, () =>
      this.buffer!.appendBuffer(prepared.data as BufferSource),
    );
    this.discontinuity = prepared.segment.discontinuity;
  }
  /** Reuse the decoder's buffer while replacing its playlist, without touching other lanes. */
  inheritBuffer(previous: MediaLane) {
    this.buffer = previous.buffer;
    this.codec = previous.codec;
    this.mime = previous.mime;
  }
}
