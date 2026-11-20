import { boxes, videoSampleEntryBoxes } from './mp4';
export interface FragmentTrack {
  id: number;
  timescale: number;
  format: string;
  video: boolean;
  duration: number;
  size: number;
  nalLength?: number;
  flags?: number;
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
export function fragmentMetadata(init: Uint8Array): FragmentTrack[] {
  const moov = child(init, 'moov');
  const defaults = new Map<
    number,
    { duration: number; size: number; flags: number }
  >();
  for (const mvex of boxes(moov).filter((b) => b.type === 'mvex'))
    for (const trex of boxes(mvex.body).filter((b) => b.type === 'trex'))
      defaults.set(u32(trex.body, 4), {
        duration: u32(trex.body, 12),
        size: u32(trex.body, 16),
        flags: u32(trex.body, 20),
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
      let nalLength: number | undefined;
      if (['avc1', 'avc3', 'hvc1', 'hev1'].includes(entry.type)) {
        const hevc = entry.type === 'hvc1' || entry.type === 'hev1';
        const config = videoSampleEntryBoxes(entry.body).find(
          (box) => box.type === (hevc ? 'hvcC' : 'avcC'),
        );
        if (config && config.body.length > (hevc ? 21 : 4))
          nalLength = (config.body[hevc ? 21 : 4] & 3) + 1;
      }
      return {
        id,
        timescale,
        nalLength,
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
export interface FragmentSample {
  dts: number;
  flags: number;
  track: FragmentTrack;
  time: number;
  duration: number;
  data: Uint8Array;
}
/** Parse fragment sample tables before caption descriptors are hidden from MSE. */
export function fragmentSamples(
  data: Uint8Array,
  metadata: FragmentTrack[],
  resourceOffset = 0,
): FragmentSample[] {
  const pending: FragmentSample[] = [];
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
      if (!meta) throw new Error('Unknown fragment track');
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
      let defaultFlags = meta.flags ?? 0;
      if (flags & 32) {
        defaultFlags = u32(tfhd, at);
        at += 4;
      }
      if (at > tfhd.length) throw new Error('Truncated fragment tfhd');
      const tfdt = child(traf.body, 'tfdt');
      let time = tfdt[0] === 1 ? u64(tfdt, 4) : u32(tfdt, 4),
        cursor = base;
      for (const trun of boxes(traf.body).filter((b) => b.type === 'trun')) {
        const d = trun.body,
          f = u32(d, 0) & 0xffffff,
          count = u32(d, 4);
        if (count > 1000000)
          throw new Error('Fragment sample count exceeds limit');
        let at = 8;
        if (f & 1) {
          cursor = base + i32(d, at);
          at += 4;
        }
        let firstFlags = defaultFlags;
        if (f & 4) {
          firstFlags = u32(d, at);
          at += 4;
        }
        for (let i = 0; i < count; i++) {
          let duration = defaultDuration,
            size = defaultSize,
            composition = 0,
            sampleFlags = i === 0 ? firstFlags : defaultFlags;
          if (f & 0x100) {
            duration = u32(d, at);
            at += 4;
          }
          if (f & 0x200) {
            size = u32(d, at);
            at += 4;
          }
          if (f & 0x400) {
            sampleFlags = u32(d, at);
            at += 4;
          }
          if (f & 0x800) {
            composition = d[0] === 1 ? i32(d, at) : u32(d, at);
            at += 4;
          }
          if (at > d.length) throw new Error('Truncated fragment trun');
          {
            if (
              !duration ||
              !size ||
              !mdats.some(
                ([start, end]) => cursor >= start && cursor + size <= end,
              )
            )
              throw new Error('Invalid fragment sample bounds');
            pending.push({
              track: meta,
              dts: time / meta.timescale,
              flags: sampleFlags,
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
  return pending;
}
