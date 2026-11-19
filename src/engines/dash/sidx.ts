import { boxes } from '../hls/mp4';
import type { DashResourceClient } from './network';
import type { Period, Representation, SegmentReference } from './model';
interface IndexReference extends SegmentReference {
  index: boolean;
  referenceId: number;
}
/** Read index entries without confusing child indexes with media ranges. */
function parseIndex(
  data: Uint8Array,
  resourceOffset: number,
  url: string,
  rep: Representation,
  period: Period,
): IndexReference[] {
  const box = boxes(data).find((b) => b.type === 'sidx');
  if (!box) throw new Error('DASH index range contains no SIDX');
  const d = box.body,
    v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  if (d.length < 24 || d[0] > 1 || (d[0] === 1 && d.length < 32))
    throw new Error('Invalid DASH SIDX');
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
  const out: IndexReference[] = [];
  for (let i = 0; i < count; i++, at += 12) {
    const reference = v.getUint32(at),
      duration = v.getUint32(at + 4),
      length = reference & 0x7fffffff;
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
      index: !!(reference >>> 31),
      referenceId: v.getUint32(4),
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

/** Synchronous flat index reader; hierarchical indexes require loadSidx. */
export function parseSidx(
  data: Uint8Array,
  offset: number,
  url: string,
  rep: Representation,
  period: Period,
): SegmentReference[] {
  const entries = parseIndex(data, offset, url, rep, period);
  if (entries.some((e) => e.index))
    throw new Error('Hierarchical SIDX requires asynchronous resolution');
  return entries.map(({ index, referenceId, ...reference }) => reference);
}
/** Expand same-resource child indexes with bounded network, depth and memory use. */
export async function loadSidx(
  client: Pick<DashResourceClient, 'get'>,
  data: Uint8Array,
  offset: number,
  url: string,
  rep: Representation,
  period: Period,
): Promise<SegmentReference[]> {
  const output: SegmentReference[] = [];
  const visited = new Set<string>();
  let bytes = data.length,
    requests = 0;
  const visit = async (
    data: Uint8Array,
    offset: number,
    url: string,
    depth: number,
    parent?: IndexReference,
  ) => {
    if (depth > 5 || bytes > 8 * 1024 * 1024)
      throw new Error('DASH SIDX expansion limit');
    const entries = parseIndex(data, offset, url, rep, period);
    if (
      parent &&
      (!entries.length ||
        entries.some((e) => e.referenceId !== parent.referenceId) ||
        Math.abs(entries[0].start - parent.start) > 0.001 ||
        Math.abs(entries.at(-1)!.end - parent.end) > 0.001)
    )
      throw new Error('DASH child SIDX timing or reference ID mismatch');
    for (const entry of entries) {
      if (!entry.index) {
        const { index, referenceId, ...reference } = entry;
        output.push({ ...reference, number: BigInt(output.length + 1) });
        if (output.length > 10000) throw new Error('DASH SIDX reference limit');
        continue;
      }
      const key = `${url}:${entry.range!.offset}:${entry.range!.length}`;
      if (
        visited.has(key) ||
        ++requests > 64 ||
        entry.range!.length > 8 * 1024 * 1024 - bytes
      )
        throw new Error('DASH SIDX request limit');
      visited.add(key);
      const child = await client.get({
        url,
        range: entry.range,
        alternatives: rep.baseUrls.filter((u) => u !== url),
      });
      bytes += child.data.length;
      await visit(child.data, entry.range!.offset, child.url, depth + 1, entry);
    }
  };
  await visit(data, offset, url, 0);
  return output;
}
