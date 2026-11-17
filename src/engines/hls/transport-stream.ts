import { hevcConfiguration } from './hevc';
import { sampleRates, aacConfiguration } from './aac';
import {
  concat,
  u32,
  initialization,
  fragment,
  type Sample,
  type Track,
} from './mp4';

class Bits {
  private at = 0;
  constructor(private data: Uint8Array) {}
  read(n: number) {
    let value = 0;
    for (let i = 0; i < n; i++) {
      if (this.at >= this.data.length * 8) throw new Error('Truncated AVC SPS');
      value =
        value * 2 + ((this.data[this.at >>> 3] >>> (7 - (this.at & 7))) & 1);
      this.at++;
    }
    return value;
  }
  ue() {
    let zeros = 0;
    while (this.read(1) === 0) {
      if (++zeros > 30) throw new Error('Invalid Exp-Golomb');
    }
    return 2 ** zeros - 1 + this.read(zeros);
  }
  se() {
    const value = this.ue();
    return value & 1 ? (value + 1) / 2 : -value / 2;
  }
}
/** Read picture dimensions from the H.264 SPS, including chroma-dependent cropping. */
export function dimensions(sps: Uint8Array) {
  const raw: number[] = [];
  for (let i = 1; i < sps.length; i++) {
    if (i >= 3 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0)
      continue;
    raw.push(sps[i]);
  }
  const b = new Bits(new Uint8Array(raw));
  const profile = b.read(8);
  b.read(16);
  b.ue();
  let chroma = 1,
    separate = 0;
  if (
    [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(
      profile,
    )
  ) {
    chroma = b.ue();
    if (chroma === 3) separate = b.read(1);
    b.ue();
    b.ue();
    b.read(1);
    if (b.read(1))
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++)
        if (b.read(1)) {
          let last = 8,
            next = 8;
          for (let j = 0; j < (i < 6 ? 16 : 64); j++) {
            if (next) next = (last + b.se() + 256) % 256;
            last = next || last;
          }
        }
  }
  b.ue();
  const poc = b.ue();
  if (poc === 0) b.ue();
  else if (poc === 1) {
    b.read(1);
    b.se();
    b.se();
    const count = b.ue();
    if (count > 256) throw new Error('Invalid POC cycle');
    for (let i = 0; i < count; i++) b.se();
  }
  b.ue();
  b.read(1);
  const cols = b.ue() + 1,
    rows = b.ue() + 1;
  const frame = b.read(1);
  if (!frame) b.read(1);
  b.read(1);
  let left = 0,
    right = 0,
    top = 0,
    bottom = 0;
  if (b.read(1)) {
    left = b.ue();
    right = b.ue();
    top = b.ue();
    bottom = b.ue();
  }
  const chromaArray = separate ? 0 : chroma;
  const cropX = chromaArray === 1 || chromaArray === 2 ? 2 : 1,
    cropY = (chromaArray === 1 ? 2 : 1) * (2 - frame);
  return {
    width: cols * 16 - (left + right) * cropX,
    height: rows * 16 * (2 - frame) - (top + bottom) * cropY,
  };
}
export function timestamp(data: Uint8Array, at: number) {
  if (at + 5 > data.length) throw new Error('Truncated PES timestamp');
  return (
    ((data[at] >>> 1) & 7) * 2 ** 30 +
    data[at + 1] * 2 ** 22 +
    (data[at + 2] >>> 1) * 2 ** 15 +
    data[at + 3] * 128 +
    (data[at + 4] >>> 1)
  );
}
export function unwrap(value: number, reference: number) {
  return value + Math.round((reference - value) / 2 ** 33) * 2 ** 33;
}
interface Pes {
  type: number;
  pts: number;
  dts: number;
  data: Uint8Array;
}
function demux(bytes: Uint8Array): Pes[] {
  if (bytes.length % 188 || bytes[0] !== 0x47)
    throw new Error('Expected 188-byte MPEG-TS packets');
  let pmt = -1;
  const types = new Map<number, number>(),
    pending = new Map<number, Uint8Array[]>(),
    packets: Pes[] = [];
  const continuity = new Map<number, number>();
  const flush = (pid: number) => {
    const parts = pending.get(pid);
    pending.delete(pid);
    if (!parts?.length) return;
    const d = concat(...parts);
    if (d.length < 14 || d[0] || d[1] || d[2] !== 1)
      throw new Error('Invalid PES header');
    const flags = d[7] >>> 6;
    if (flags !== 2 && flags !== 3) throw new Error('PES needs PTS');
    const length = (d[4] << 8) | d[5],
      end = length ? 6 + length : d.length,
      start = 9 + d[8];
    if (end > d.length || start > end)
      throw new Error('Incomplete PES at segment boundary');
    packets.push({
      type: types.get(pid)!,
      pts: timestamp(d, 9),
      dts: flags === 3 ? timestamp(d, 14) : timestamp(d, 9),
      data: d.subarray(start, end),
    });
  };
  for (let at = 0; at < bytes.length; at += 188) {
    const d = bytes.subarray(at, at + 188);
    if (d[0] !== 0x47 || d[1] & 0x80 || d[3] & 0xc0)
      throw new Error('Corrupt or scrambled TS packet');
    const pid = ((d[1] & 31) << 8) | d[2],
      start = !!(d[1] & 0x40),
      adapt = (d[3] >>> 4) & 3;
    if (!(adapt & 1)) continue;
    const offset = adapt & 2 ? 5 + d[4] : 4;
    if (offset > 188) throw new Error('Invalid TS adaptation field');
    if (offset === 188) continue;
    const discontinuity = !!(adapt & 2 && d[4] && d[5] & 0x80),
      cc = d[3] & 15,
      previous = continuity.get(pid);
    if (types.has(pid) && previous !== undefined && !discontinuity) {
      if (cc === previous) continue;
      if (cc !== (previous + 1) % 16) throw new Error('MPEG-TS packet loss');
    }
    continuity.set(pid, cc);
    let payload = d.subarray(offset);
    if (pid === 0 || pid === pmt) {
      if (!start) continue;
      payload = payload.subarray(1 + payload[0]);
      if (payload.length < 8) throw new Error('Invalid PSI table');
      const end = 3 + ((payload[1] & 15) << 8) + payload[2] - 4;
      if (end + 4 > payload.length)
        throw new Error('Multi-packet PSI is not yet supported');
      if (pid === 0) {
        for (let i = 8; i + 4 <= end; i += 4)
          if (payload[i] || payload[i + 1]) {
            pmt = ((payload[i + 2] & 31) << 8) | payload[i + 3];
            break;
          }
      } else {
        let i = 12 + ((payload[10] & 15) << 8) + payload[11];
        for (; i + 5 <= end; ) {
          const type = payload[i],
            elementary = ((payload[i + 1] & 31) << 8) | payload[i + 2];
          if (type === 0x1b || type === 0x24 || type === 0x0f) {
            if (
              Array.from(types).some(
                ([pid, value]) => value === type && pid !== elementary,
              )
            )
              throw new Error(
                'Multiple same-kind elementary streams are not yet supported',
              );
            types.set(elementary, type);
          } else if ([0x03, 0x04, 0x81, 0x87].includes(type))
            throw new Error('TS baseline supports AVC/HEVC/AAC only');
          i += 5 + ((payload[i + 3] & 15) << 8) + payload[i + 4];
        }
      }
    } else if (types.has(pid)) {
      if (start) flush(pid);
      if (start || pending.has(pid)) {
        const list = pending.get(pid) ?? [];
        list.push(payload);
        pending.set(pid, list);
      }
    }
  }
  for (const pid of pending.keys()) flush(pid);
  if (!packets.length)
    throw new Error('No supported AVC/HEVC/AAC elementary streams');
  return packets;
}
function nals(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i < data.length - 2; i++)
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      (data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))
    ) {
      if (start >= 0) out.push(data.subarray(start, i));
      const length = data[i + 2] === 1 ? 3 : 4;
      start = i + length;
      i = start - 1;
    }
  if (start >= 0) out.push(data.subarray(start));
  return out.filter((n) => n.length);
}
export class TsTransmuxer {
  private vps?: Uint8Array;
  private sps?: Uint8Array;
  private pps?: Uint8Array;
  private clock?: number;
  private serial = 0;
  constructor(private audioCodec = 'mp4a.40.2') {}
  reset() {
    this.clock = undefined;
  }
  transmux(bytes: Uint8Array, segmentDuration: number) {
    const pes = demux(bytes);
    const first = pes.find((p) => p.type === 0x1b || p.type === 0x24) ?? pes[0];
    const reference = this.clock ?? first.dts;
    for (const p of pes) {
      p.dts = unwrap(p.dts, reference);
      p.pts = unwrap(p.pts, p.dts);
    }
    this.clock = first.dts;
    const tracks: Track[] = [],
      media: Uint8Array[] = [];
    const starts: number[] = [];
    const hevc = pes.some((p) => p.type === 0x24);
    if (hevc && pes.some((p) => p.type === 0x1b))
      throw new Error('Mixed AVC and HEVC elementary streams');
    const pictures: { sample: Sample; dts: number }[] = [];
    for (const p of pes.filter((p) => p.type === 0x1b || p.type === 0x24)) {
      const units = nals(p.data);
      if (hevc) {
        if (
          units.some(
            (n) => n.length < 2 || n[0] & 0x81 || n[1] & 0xf8 || !(n[1] & 7),
          )
        )
          throw new Error('Invalid or unsupported multilayer HEVC NAL');
        const type = (n: Uint8Array) => (n[0] >>> 1) & 63;
        if (units.filter((n) => type(n) < 32 && n[2] & 128).length > 1)
          throw new Error(
            'Multiple HEVC access units per PES are not yet supported',
          );
        for (const unit of units) {
          const previous =
            type(unit) === 32
              ? this.vps
              : type(unit) === 33
                ? this.sps
                : type(unit) === 34
                  ? this.pps
                  : undefined;
          if (
            pictures.length &&
            previous &&
            (previous.length !== unit.length ||
              previous.some((value, i) => value !== unit[i]))
          )
            throw new Error('HEVC parameter sets changed within a segment');
          if (type(unit) === 32) this.vps = unit;
          if (type(unit) === 33) this.sps = unit;
          if (type(unit) === 34) this.pps = unit;
        }
        if (!units.some((n) => type(n) < 32)) continue;
        const keep = units.filter(
          (n) => ![32, 33, 34, 35, 38].includes(type(n)),
        );
        pictures.push({
          dts: p.dts,
          sample: {
            data: concat(...keep.flatMap((n) => [u32(n.length), n])),
            duration: 0,
            cts: Math.round(p.pts - p.dts),
            key: units.some((n) => type(n) >= 16 && type(n) <= 21),
          },
        });
        continue;
      }
      if (units.filter((n) => (n[0] & 31) === 9).length > 1)
        throw new Error(
          'Multiple AVC access units per PES are not yet supported',
        );
      for (const unit of units) {
        if ((unit[0] & 31) === 7) this.sps = unit;
        if ((unit[0] & 31) === 8) this.pps = unit;
      }
      const picture = units.some((n) => [1, 5].includes(n[0] & 31));
      if (!picture) continue;
      const keep = units.filter((n) => ![7, 8, 9, 12].includes(n[0] & 31));
      pictures.push({
        dts: p.dts,
        sample: {
          data: concat(...keep.flatMap((n) => [u32(n.length), n])),
          duration: 0,
          cts: Math.round(p.pts - p.dts),
          key: units.some((n) => (n[0] & 31) === 5),
        },
      });
    }
    if (pictures.length) {
      if (!this.sps || !this.pps)
        throw new Error('Missing video parameter sets');
      if (!pictures[0].sample.key)
        throw new Error('TS baseline needs independently decodable segments');
      const t: Track = {
        id: 1,
        kind: 'video',
        timescale: 90000,
        codec:
          'avc1.' +
          Array.from(this.sps.subarray(1, 4), (n) =>
            n.toString(16).padStart(2, '0'),
          ).join(''),
        sps: this.sps,
        pps: this.pps,
        ...(hevc
          ? (() => {
              if (!this.vps) throw new Error('Missing HEVC VPS');
              return hevcConfiguration(this.vps, this.sps!, this.pps!);
            })()
          : dimensions(this.sps)),
      };
      for (let i = 0; i < pictures.length; i++) {
        const duration = pictures[i + 1]
          ? pictures[i + 1].dts - pictures[i].dts
          : i
            ? pictures[i - 1].sample.duration
            : 90000 * segmentDuration;
        if (duration <= 0)
          throw new Error('Non-increasing video decode timestamps');
        pictures[i].sample.duration = Math.round(duration);
      }
      tracks.push(t);
      starts.push(pictures[0].dts / 90000);
      media.push(
        fragment(
          t,
          pictures.map((p) => p.sample),
          pictures[0].dts,
          ++this.serial,
        ),
      );
    }
    const audio = pes.filter((p) => p.type === 0x0f);
    if (audio.length) {
      const bytes = concat(...audio.map((p) => p.data)),
        samples: Sample[] = [];
      let track: Track | undefined;
      for (let at = 0; at < bytes.length; ) {
        if (
          at + 7 > bytes.length ||
          bytes[at] !== 255 ||
          (bytes[at + 1] & 0xf6) !== 0xf0
        )
          throw new Error('Invalid or incomplete ADTS frame');
        const index = (bytes[at + 2] >>> 2) & 15,
          rate = sampleRates[index],
          objectType = (bytes[at + 2] >>> 6) + 1,
          channels = ((bytes[at + 2] & 1) << 2) | (bytes[at + 3] >>> 6);
        const length =
            ((bytes[at + 3] & 3) << 11) |
            (bytes[at + 4] << 3) |
            (bytes[at + 5] >>> 5),
          header = bytes[at + 1] & 1 ? 7 : 9;
        if (
          !rate ||
          !channels ||
          objectType !== 2 ||
          bytes[at + 6] & 3 ||
          length < header ||
          at + length > bytes.length
        )
          throw new Error('Unsupported AAC configuration or incomplete frame');
        const config = aacConfiguration(index, channels, this.audioCodec);
        if (!track)
          track = {
            id: 2,
            kind: 'audio',
            timescale: config.rate,
            channels,
            codec: config.codec,
            asc: config.asc,
          };
        if (track.timescale !== config.rate || track.channels !== channels)
          throw new Error('AAC configuration changed within a segment');
        samples.push({
          data: bytes.slice(at + header, at + length),
          duration: config.duration,
          cts: 0,
          key: true,
        });
        at += length;
      }
      if (track) {
        tracks.push(track);
        starts.push(audio[0].pts / 90000);
        media.push(
          fragment(
            track,
            samples,
            (audio[0].pts * track.timescale) / 90000,
            ++this.serial,
          ),
        );
      }
    }
    return {
      tracks,
      init: initialization(tracks),
      media: concat(...media),
      start: Math.min(...starts),
    };
  }
}
