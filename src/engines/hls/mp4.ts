import { av1Codec } from './av1';
import { hevcCodec } from './hevc';

/** ISO BMFF reader/writer for AVC, HEVC and AAC. */
export const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const ascii = (value: string) => new TextEncoder().encode(value);
const u16 = (value: number) => new Uint8Array([value >>> 8, value & 255]);
export const u32 = (value: number) =>
  new Uint8Array([
    value >>> 24,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
const zero = (n: number) => new Uint8Array(n);
export const box = (name: string, ...parts: Uint8Array[]) => {
  const body = concat(...parts);
  return concat(u32(body.length + 8), ascii(name), body);
};
const full = (
  name: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
) =>
  box(
    name,
    new Uint8Array([version, flags >>> 16, (flags >>> 8) & 255, flags & 255]),
    ...parts,
  );
const matrix = concat(
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x10000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
);
export interface Sample {
  data: Uint8Array;
  duration: number;
  cts: number;
  key: boolean;
}
export interface Track {
  audioObjectType?: number;
  dac3?: Uint8Array;
  dec3?: Uint8Array;
  encryption?: { scheme: 'cenc' | 'cbcs'; kid: Uint8Array };
  id: number;
  kind: 'video' | 'audio';
  timescale: number;
  codec: string;
  width?: number;
  height?: number;
  sps?: Uint8Array;
  pps?: Uint8Array;
  hvcc?: Uint8Array;
  asc?: Uint8Array;
  channels?: number;
}
export interface Mp4Box {
  type: string;
  body: Uint8Array;
  at: number;
  size: number;
}
export function boxes(data: Uint8Array): Mp4Box[] {
  return parseBoxes(data);
}
/** QuickTime permits exactly four zero bytes after video sample extensions.
 * https://developer.apple.com/documentation/quicktime-file-format/video_sample_description
 * Keep this exception local to visual sample entries, never general MP4 boxes.
 */
export function videoSampleEntryBoxes(body: Uint8Array): Mp4Box[] {
  if (body.length < 78) throw new Error('Truncated video sample entry');
  return parseBoxes(body.subarray(78), true);
}
function parseBoxes(data: Uint8Array, videoTerminator = false): Mp4Box[] {
  const out: Mp4Box[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 0; at < data.length; ) {
    if (videoTerminator && data.length - at === 4 && view.getUint32(at) === 0)
      break;
    if (at + 8 > data.length) throw new Error('Truncated MP4 header');
    if (
      videoTerminator &&
      view.getUint32(at) === 0 &&
      view.getUint32(at + 4) === 0
    )
      throw new Error('Invalid MP4 video sample terminator');
    let size = view.getUint32(at),
      header = 8;
    if (size === 1) {
      if (at + 16 > data.length) throw new Error('Truncated large MP4 box');
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    }
    if (!size) size = data.length - at;
    if (!Number.isSafeInteger(size) || size < header || at + size > data.length)
      throw new Error('Invalid MP4 box');
    out.push({
      type: String.fromCharCode(...data.subarray(at + 4, at + 8)),
      body: data.subarray(at + header, at + size),
      at,
      size,
    });
    at += size;
  }
  return out;
}
const child = (data: Uint8Array, type: string) => {
  const found = boxes(data).find((b) => b.type === type);
  if (!found) throw new Error(`Missing ${type}`);
  return found.body;
};
const videoChild = (body: Uint8Array, type: string) => {
  const found = videoSampleEntryBoxes(body).find((box) => box.type === type);
  if (!found) throw new Error(`Missing ${type}`);
  return found.body;
};
const read32 = (data: Uint8Array, offset: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
/** Walk ISO elementary-stream descriptors, including variable-length sizes. */
function audioObjectType(data: Uint8Array): number {
  for (let at = 0; at < data.length; ) {
    const tag = data[at++];
    let length = 0,
      last = 0;
    for (let n = 0; n < 4; n++) {
      if (at >= data.length) throw new Error('Truncated ES descriptor');
      last = data[at++];
      length = length * 128 + (last & 127);
      if (!(last & 128)) break;
    }
    if (last & 128 || at + length > data.length)
      throw new Error('Invalid ES descriptor size');
    const body = data.subarray(at, at + length);
    at += length;
    if (tag === 5) {
      if (body.length < 2) throw new Error('Truncated AudioSpecificConfig');
      const type = body[0] >>> 3;
      if (![2, 5, 29].includes(type))
        throw new Error('Unsupported AAC object type');
      return type;
    }
    if (tag === 3) {
      if (body.length < 3) throw new Error('Truncated ES descriptor');
      const flags = body[2];
      let offset = 3;
      if (flags & 128) offset += 2;
      if (flags & 64) {
        if (offset >= body.length) throw new Error('Truncated ES URL');
        offset += 1 + body[offset];
      }
      if (flags & 32) offset += 2;
      if (offset > body.length) throw new Error('Truncated ES flags');
      return audioObjectType(body.subarray(offset));
    }
    if (tag === 4) {
      if (body.length < 13)
        throw new Error('Truncated audio decoder descriptor');
      if (body[0] === 0x6b || body[0] === 0x69) return -1;
      if (body[0] !== 0x40)
        throw new Error('Unsupported audio decoder descriptor');
      return audioObjectType(body.subarray(13));
    }
  }
  throw new Error('Missing AudioSpecificConfig');
}
export function inspectInit(data: Uint8Array): Track[] {
  const moov = child(data, 'moov');
  return boxes(moov)
    .filter((b) => b.type === 'trak')
    .map(({ body: trak }) => {
      const tkhd = child(trak, 'tkhd'),
        mdia = child(trak, 'mdia'),
        mdhd = child(mdia, 'mdhd'),
        hdlr = child(mdia, 'hdlr');
      const kind =
        String.fromCharCode(...hdlr.subarray(8, 12)) === 'vide'
          ? 'video'
          : 'audio';
      const stsd = child(child(child(mdia, 'minf'), 'stbl'), 'stsd');
      const entry = boxes(stsd.subarray(8))[0];
      let encryption: Track['encryption'];
      if (entry.type === 'encv' || entry.type === 'enca') {
        const sinf =
          entry.type === 'encv'
            ? videoChild(entry.body, 'sinf')
            : child(entry.body.subarray(28), 'sinf');
        const original = child(sinf, 'frma'),
          schm = child(sinf, 'schm');
        const scheme = String.fromCharCode(...schm.subarray(4, 8));
        if (scheme !== 'cenc' && scheme !== 'cbcs')
          throw new Error('Unsupported protection scheme ' + scheme);
        const tenc = child(child(sinf, 'schi'), 'tenc');
        if (tenc.length < 24 || tenc[0] > 1 || tenc[6] !== 1)
          throw new Error('Invalid protected track defaults');
        if (
          ![0, 8, 16].includes(tenc[7]) ||
          (scheme === 'cenc' && tenc[7] === 0)
        )
          throw new Error('Invalid encryption IV size');
        if (
          tenc[7] === 0 &&
          (tenc.length < 25 ||
            ![8, 16].includes(tenc[24]) ||
            tenc.length !== 25 + tenc[24])
        )
          throw new Error('Invalid constant encryption IV');
        encryption = { scheme, kid: tenc.slice(8, 24) };
        entry.type = String.fromCharCode(...original);
      }
      let codec: string;
      if (entry.type === 'avc1' || entry.type === 'avc3') {
        const avcc = videoChild(entry.body, 'avcC');
        codec =
          entry.type +
          '.' +
          Array.from(avcc.subarray(1, 4), (n) =>
            n.toString(16).padStart(2, '0'),
          ).join('');
      } else if (entry.type === 'hvc1' || entry.type === 'hev1') {
        codec = hevcCodec(videoChild(entry.body, 'hvcC'), entry.type);
      } else if (entry.type === 'av01') {
        const children = videoSampleEntryBoxes(entry.body);
        const configs = children.filter((b) => b.type === 'av1C');
        if (configs.length !== 1)
          throw new Error('AV1 needs exactly one av1C box');
        codec = av1Codec(
          configs[0].body,
          children.find((b) => b.type === 'colr')?.body,
        );
      } else if (entry.type === 'ac-3' || entry.type === 'ec-3') {
        const config = child(
          entry.body.subarray(28),
          entry.type === 'ac-3' ? 'dac3' : 'dec3',
        );
        if (config.length < (entry.type === 'ac-3' ? 3 : 5))
          throw new Error('Truncated Dolby audio configuration');
        codec = entry.type;
      } else if (entry.type === 'mp4a') {
        const esds = child(entry.body.subarray(28), 'esds');
        const objectType = audioObjectType(esds.subarray(4));
        codec = objectType === -1 ? 'mp3' : 'mp4a.40.' + objectType;
      } else
        throw new Error(
          `Unsupported HLS sample entry ${entry.type}; supports AVC/HEVC/AV1/AAC/MP3/AC-3/E-AC-3`,
        );
      return {
        id: read32(tkhd, tkhd[0] === 1 ? 20 : 12),
        kind,
        timescale: read32(mdhd, mdhd[0] === 1 ? 20 : 12),
        codec,
        ...(encryption ? { encryption } : {}),
      } as Track;
    });
}
export function decodeTime(data: Uint8Array, tracks: Track[]): number {
  const starts: number[] = [];
  for (const top of boxes(data).filter((b) => b.type === 'moof'))
    for (const traf of boxes(top.body).filter((b) => b.type === 'traf')) {
      const tfhd = child(traf.body, 'tfhd'),
        tfdt = child(traf.body, 'tfdt');
      const track = tracks.find((t) => t.id === read32(tfhd, 4));
      if (!track) throw new Error('Unknown fragment track');
      const view = new DataView(tfdt.buffer, tfdt.byteOffset, tfdt.byteLength);
      starts.push(
        Number(tfdt[0] === 1 ? view.getBigUint64(4) : view.getUint32(4)) /
          track.timescale,
      );
    }
  if (!starts.length) throw new Error('Missing fragment timestamps');
  return Math.min(...starts);
}
function sampleEntry(t: Track): Uint8Array {
  if (t.kind === 'video') {
    const sps = t.sps!,
      pps = t.pps!;
    const avcc = t.hvcc
      ? box('hvcC', t.hvcc)
      : box(
          'avcC',
          new Uint8Array([1, sps[1], sps[2], sps[3], 255, 225]),
          u16(sps.length),
          sps,
          new Uint8Array([1]),
          u16(pps.length),
          pps,
        );
    return box(
      t.hvcc ? 'hvc1' : t.codec.startsWith('avc3.') ? 'avc3' : 'avc1',
      zero(6),
      u16(1),
      zero(16),
      u16(t.width!),
      u16(t.height!),
      u32(0x480000),
      u32(0x480000),
      u32(0),
      u16(1),
      zero(32),
      u16(24),
      u16(65535),
      avcc,
    );
  }
  if (t.codec === 'ac-3' || t.codec === 'ec-3')
    return box(
      t.codec,
      zero(6),
      u16(1),
      zero(8),
      u16(2),
      u16(16),
      zero(4),
      u32(t.timescale * 65536),
      box(
        t.codec === 'ac-3' ? 'dac3' : 'dec3',
        (t.codec === 'ac-3' ? t.dac3 : t.dec3)!,
      ),
    );
  const descriptor = (tag: number, ...parts: Uint8Array[]) => {
    const data = concat(...parts);
    if (data.length > 127) throw new Error('Descriptor too large');
    return concat(new Uint8Array([tag, data.length]), data);
  };
  const config = descriptor(
    4,
    new Uint8Array([
      t.codec === 'mp3' ? (t.audioObjectType ?? 0x6b) : 0x40,
      0x15,
      0,
      0,
      0,
    ]),
    u32(128000),
    u32(128000),
    ...(t.codec === 'mp3' ? [] : [descriptor(5, t.asc!)]),
  );
  const esds = full(
    'esds',
    0,
    0,
    descriptor(
      3,
      u16(t.id),
      new Uint8Array([0]),
      config,
      descriptor(6, new Uint8Array([2])),
    ),
  );
  return box(
    'mp4a',
    zero(6),
    u16(1),
    zero(8),
    u16(t.channels!),
    u16(16),
    zero(4),
    u32(t.timescale * 65536),
    esds,
  );
}
export function initialization(tracks: Track[]): Uint8Array {
  const mvhd = full(
    'mvhd',
    0,
    0,
    zero(8),
    u32(1000),
    u32(0),
    u32(0x10000),
    u16(0x100),
    zero(10),
    matrix,
    zero(24),
    u32(Math.max(...tracks.map((t) => t.id)) + 1),
  );
  const traks = tracks.map((t) => {
    const tkhd = full(
      'tkhd',
      0,
      7,
      zero(8),
      u32(t.id),
      u32(0),
      u32(0),
      zero(8),
      u16(0),
      u16(0),
      u16(t.kind === 'audio' ? 0x100 : 0),
      u16(0),
      matrix,
      u32((t.width ?? 0) * 65536),
      u32((t.height ?? 0) * 65536),
    );
    const mdhd = full(
      'mdhd',
      0,
      0,
      zero(8),
      u32(t.timescale),
      u32(0),
      u16(0x55c4),
      u16(0),
    );
    const hdlr = full(
      'hdlr',
      0,
      0,
      u32(0),
      ascii(t.kind === 'video' ? 'vide' : 'soun'),
      zero(12),
      ascii('ThePlayer\0'),
    );
    const mediaHeader =
      t.kind === 'video'
        ? full('vmhd', 0, 1, zero(8))
        : full('smhd', 0, 0, zero(4));
    const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
    const stbl = box(
      'stbl',
      full('stsd', 0, 0, u32(1), sampleEntry(t)),
      full('stts', 0, 0, u32(0)),
      full('stsc', 0, 0, u32(0)),
      full('stsz', 0, 0, u32(0), u32(0)),
      full('stco', 0, 0, u32(0)),
    );
    return box(
      'trak',
      tkhd,
      box('mdia', mdhd, hdlr, box('minf', mediaHeader, dinf, stbl)),
    );
  });
  const mvex = box(
    'mvex',
    ...tracks.map((t) =>
      full('trex', 0, 0, u32(t.id), u32(1), u32(0), u32(0), u32(0)),
    ),
  );
  return concat(
    box('ftyp', ascii('iso6'), u32(1), ascii('iso6isommp41')),
    box('moov', mvhd, ...traks, mvex),
  );
}
export function fragment(
  track: Track,
  samples: Sample[],
  time: number,
  sequence: number,
): Uint8Array {
  const tfdt = new Uint8Array(8);
  new DataView(tfdt.buffer).setBigUint64(0, BigInt(Math.round(time)));
  const traf = (offset: number) =>
    box(
      'traf',
      full('tfhd', 0, 0x20000, u32(track.id)),
      full('tfdt', 1, 0, tfdt),
      full(
        'trun',
        1,
        0xf01,
        u32(samples.length),
        u32(offset),
        ...samples.map((s) =>
          concat(
            u32(s.duration),
            u32(s.data.length),
            u32(s.key ? 0x02000000 : 0x01010000),
            u32(s.cts),
          ),
        ),
      ),
    );
  let moof = box('moof', full('mfhd', 0, 0, u32(sequence)), traf(0));
  moof = box('moof', full('mfhd', 0, 0, u32(sequence)), traf(moof.length + 8));
  return concat(moof, box('mdat', ...samples.map((s) => s.data)));
}
