import { boxes } from '../hls/mp4';
import type { Period, Representation, SegmentReference } from './model';
/** Resolve a flat ISO BMFF segment index, preserving absolute byte offsets. */
export function parseSidx(
  data: Uint8Array,
  resourceOffset: number,
  url: string,
  rep: Representation,
  period: Period,
): SegmentReference[] {
  const box = boxes(data).find((b) => b.type === 'sidx');
  if (!box) throw new Error('DASH index range contains no SIDX');
  const d = box.body,
    v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 24 || d[0] > 1) throw new Error('Invalid DASH SIDX');
  const timescale = v.getUint32(8);
  if (!timescale) throw new Error('Invalid SIDX timescale');
  let at = 12;
  const readTime = () => {
    const value = d[0] ? v.getBigUint64(at) : BigInt(v.getUint32(at));
    at += d[0] ? 8 : 4;
    return value;
  };
  let time = readTime();
  const firstOffset = readTime();
  if (at + 4 > d.length) throw new Error('Truncated SIDX');
  const count = v.getUint16(at + 2);
  at += 4;
  if (count > 10000 || at + count * 12 !== d.length)
    throw new Error('Invalid SIDX reference table');
  let offset = BigInt(resourceOffset + box.at + box.size) + firstOffset;
  const out: SegmentReference[] = [];
  for (let i = 0; i < count; i++, at += 12) {
    const reference = v.getUint32(at),
      duration = v.getUint32(at + 4),
      length = reference & 0x7fffffff;
    if (reference >>> 31)
      throw new Error('Hierarchical SIDX is not implemented');
    if (
      !length ||
      !duration ||
      offset + BigInt(length) > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid SIDX segment');
    const start =
      period.start +
      Number(time) / timescale -
      Number(rep.address.presentationTimeOffset) / rep.address.timescale;
    out.push({
      url,
      range: { offset: Number(offset), length },
      number: BigInt(i + 1),
      time,
      start,
      end: start + duration / timescale,
    });
    time += BigInt(duration);
    offset += BigInt(length);
  }
  return out;
}
