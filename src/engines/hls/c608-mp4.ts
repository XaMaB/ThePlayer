import { boxes } from './mp4';
export interface CaptionPacket {
  time: number;
  first: number;
  second: number;
}
interface Meta {
  id: number;
  timescale: number;
  format: string;
  video: boolean;
  duration: number;
  size: number;
}
const u32 = (d: Uint8Array, at: number) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getUint32(at);
const i32 = (d: Uint8Array, at: number) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).getInt32(at);
const u64 = (d: Uint8Array, at: number) => {
  const n = Number(
    new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(at),
  );
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe MP4 offset');
  return n;
};
const child = (d: Uint8Array, type: string) => {
  const b = boxes(d).find((b) => b.type === type);
  if (!b) throw new Error('Missing ' + type);
  return b.body;
};
export function captionMetadata(init: Uint8Array): Meta[] {
  const moov = child(init, 'moov');
  const defaults = new Map<number, { duration: number; size: number }>();
  for (const mvex of boxes(moov).filter((b) => b.type === 'mvex'))
    for (const trex of boxes(mvex.body).filter((b) => b.type === 'trex'))
      defaults.set(u32(trex.body, 4), {
        duration: u32(trex.body, 12),
        size: u32(trex.body, 16),
      });
  return boxes(moov)
    .filter((b) => b.type === 'trak')
    .map((b) => {
      const tkhd = child(b.body, 'tkhd'),
        mdia = child(b.body, 'mdia'),
        mdhd = child(mdia, 'mdhd');
      const id = u32(tkhd, tkhd[0] === 1 ? 20 : 12),
        timescale = u32(mdhd, mdhd[0] === 1 ? 20 : 12);
      if (!timescale) throw new Error('Invalid caption timescale');
      const entry = boxes(
        child(child(child(mdia, 'minf'), 'stbl'), 'stsd').subarray(8),
      )[0];
      return {
        id,
        timescale,
        format: entry.type,
        video:
          String.fromCharCode(...child(mdia, 'hdlr').subarray(8, 12)) ===
          'vide',
        duration: 0,
        size: 0,
        ...defaults.get(id),
      };
    });
}
/** Parse fragment sample tables before caption descriptors are hidden from MSE. */
export function extract608(
  data: Uint8Array,
  metadata: Meta[],
  resourceOffset = 0,
): CaptionPacket[] {
  if (!metadata.some((t) => t.format === 'c608')) return [];
  if (metadata.filter((t) => t.format === 'c608').length > 1)
    throw new Error('Multiple c608 tracks are not yet supported');
  const pending: { time: number; duration: number; data: Uint8Array }[] = [];
  let frameDuration = 0;
  const top = boxes(data),
    mdats = top
      .filter((b) => b.type === 'mdat')
      .map((b) => [
        b.body.byteOffset - data.byteOffset,
        b.body.byteOffset - data.byteOffset + b.body.length,
      ]);
  for (const moof of top.filter((b) => b.type === 'moof')) {
    let implicitBase = moof.at;
    for (const traf of boxes(moof.body).filter((b) => b.type === 'traf')) {
      const tfhd = child(traf.body, 'tfhd'),
        flags = u32(tfhd, 0) & 0xffffff;
      const meta = metadata.find((t) => t.id === u32(tfhd, 4));
      if (!meta) throw new Error('Unknown caption fragment track');
      let at = 8,
        base = flags & 0x20000 ? moof.at : implicitBase;
      if (flags & 1) {
        base = u64(tfhd, at) - resourceOffset;
        at += 8;
      }
      if (flags & 2) at += 4;
      let defaultDuration = meta.duration,
        defaultSize = meta.size;
      if (flags & 8) {
        defaultDuration = u32(tfhd, at);
        at += 4;
      }
      if (flags & 16) {
        defaultSize = u32(tfhd, at);
        at += 4;
      }
      if (flags & 32) at += 4;
      if (at > tfhd.length) throw new Error('Truncated caption tfhd');
      const tfdt = child(traf.body, 'tfdt');
      let time = tfdt[0] === 1 ? u64(tfdt, 4) : u32(tfdt, 4),
        cursor = base;
      for (const trun of boxes(traf.body).filter((b) => b.type === 'trun')) {
        const d = trun.body,
          f = u32(d, 0) & 0xffffff,
          count = u32(d, 4);
        if (count > 1000000)
          throw new Error('Caption sample count exceeds limit');
        let at = 8;
        if (f & 1) {
          cursor = base + i32(d, at);
          at += 4;
        }
        if (f & 4) at += 4;
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration,
            size = defaultSize,
            composition = 0;
          if (f & 0x100) {
            duration = u32(d, at);
            at += 4;
          }
          if (f & 0x200) {
            size = u32(d, at);
            at += 4;
          }
          if (f & 0x400) at += 4;
          if (f & 0x800) {
            composition = d[0] === 1 ? i32(d, at) : u32(d, at);
            at += 4;
          }
          if (at > d.length) throw new Error('Truncated caption trun');
          if (meta.video && duration > 0 && !frameDuration)
            frameDuration = duration / meta.timescale;
          if (meta.format === 'c608') {
            if (
              !duration ||
              !size ||
              !mdats.some(
                ([start, end]) => cursor >= start && cursor + size <= end,
              )
            )
              throw new Error('Invalid c608 sample bounds');
            pending.push({
              time: (time + composition) / meta.timescale,
              duration: duration / meta.timescale,
              data: data.subarray(cursor, cursor + size),
            });
          }
          time += duration;
          cursor += size;
        }
      }
      implicitBase = cursor;
    }
  }
  const packets: CaptionPacket[] = [];
  for (const sample of pending) {
    let index = 0;
    for (const atom of boxes(sample.data)) {
      if (atom.type !== 'cdat') continue;
      if (atom.body.length % 2) throw new Error('Odd cdat byte count');
      if (atom.body.length > 2 && !(frameDuration > 0 && frameDuration <= 1))
        throw new Error('Missing video cadence for cdat');
      for (let i = 0; i < atom.body.length; i += 2, index++) {
        const delta = index * frameDuration;
        if (delta >= sample.duration + 0.001)
          throw new Error('cdat pairs exceed sample duration');
        packets.push({
          time: sample.time + delta,
          first: atom.body[i],
          second: atom.body[i + 1],
        });
      }
    }
  }
  return packets.sort((a, b) => a.time - b.time);
}
