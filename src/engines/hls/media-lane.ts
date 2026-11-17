import { bufferedAhead } from './buffer';
import type { Playlist, Segment, Key, Resource } from './playlist';
import { TsTransmuxer } from './transport-stream';
import { inspectInit, decodeTime, type Track } from './mp4';

export interface LoadedResource {
  data: Uint8Array;
  url: string;
  elapsed: number;
}
export interface PreparedSegment {
  segment: Segment;
  init: Uint8Array;
  data: Uint8Array;
  tracks: Track[];
  rawStart: number;
  bytes: number;
  elapsed: number;
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
  private preparedDiscontinuity = -1;
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
    let data = await this.decrypt(response.data, segment.key, segment.sequence);
    if (this.preparedDiscontinuity !== segment.discontinuity) {
      this.decoder.reset();
      this.preparedDiscontinuity = segment.discontinuity;
    }
    let init: Uint8Array, tracks: Track[], rawStart: number;
    if (segment.map) {
      const key = JSON.stringify([segment.map, segment.key]);
      if (this.initCache?.key !== key) {
        if (segment.key && !segment.key.iv)
          throw new Error('Encrypted initialization needs an explicit IV');
        const loaded = await this.load(segment.map);
        this.initCache = {
          key,
          data: await this.decrypt(loaded.data, segment.key, segment.sequence),
        };
      }
      init = this.initCache.data;
      tracks = inspectInit(init);
      rawStart = decodeTime(data, tracks);
    } else if (data[0] === 0x47) {
      const result = this.decoder.transmux(data, segment.duration);
      init = result.init;
      tracks = result.tracks;
      data = result.media;
      rawStart = result.start;
    } else throw new Error('Expected MPEG-TS or fMP4 with EXT-X-MAP');
    if (this.role === 'audio' && tracks.some((t) => t.kind !== 'audio'))
      throw new Error('Audio rendition contains a non-audio track');
    return {
      segment,
      init,
      data,
      tracks,
      rawStart,
      bytes: response.data.length,
      elapsed: response.elapsed,
    };
  }
  configure(media: MediaSource, prepared: PreparedSegment) {
    const codec = prepared.tracks.map((t) => t.codec).join(','),
      mime = `${prepared.tracks.some((t) => t.kind === 'video') ? 'video' : 'audio'}/mp4; codecs="${codec}"`;
    if (!MediaSource.isTypeSupported(mime))
      throw new Error('Unsupported browser codec: ' + codec);
    if (!this.buffer) {
      this.buffer = media.addSourceBuffer(mime);
      this.buffer.mode = 'segments';
    } else if (this.codec !== codec) this.buffer.changeType(mime);
    this.codec = codec;
    this.tracks = prepared.tracks;
  }
  async append(
    prepared: PreparedSegment,
    offset: number,
    operation: (buffer: SourceBuffer, action: () => void) => Promise<void>,
  ) {
    this.offset = offset;
    this.buffer!.timestampOffset = offset;
    const previous = this.appendedInit;
    if (
      !previous ||
      previous.length !== prepared.init.length ||
      previous.some((value, i) => value !== prepared.init[i])
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
  }
}
