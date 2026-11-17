import { boxes, type Mp4Box } from './mp4';

export interface IgnoredCaptionTrack {
  id: number;
  format: string;
}
const read32 = (data: Uint8Array, at: number) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at);
const child = (data: Uint8Array, type: string) => {
  const found = boxes(data).find((b) => b.type === type);
  if (!found) throw new Error('Missing ' + type);
  return found.body;
};
/** Keep byte positions intact: trun offsets, absolute base offsets and indexes
 * still refer to the original media payload. Caption payload is never decoded.
 */
function neutralize(data: Uint8Array, body: Uint8Array, entry: Mp4Box) {
  const at = body.byteOffset - data.byteOffset + entry.at;
  data.set([102, 114, 101, 101], at + 4); // ISO BMFF free space box
}
export function filterCaptionInit(input: Uint8Array) {
  const data = input.slice(),
    moov = child(data, 'moov');
  const ignored: IgnoredCaptionTrack[] = [];
  for (const trak of boxes(moov).filter((b) => b.type === 'trak')) {
    const mdia = child(trak.body, 'mdia');
    const handler = String.fromCharCode(...child(mdia, 'hdlr').subarray(8, 12));
    if (handler !== 'clcp') continue;
    const entries = boxes(
      child(child(child(mdia, 'minf'), 'stbl'), 'stsd').subarray(8),
    );
    if (
      !entries.length ||
      entries.some((e) => !['c608', 'c708'].includes(e.type))
    )
      continue;
    const tkhd = child(trak.body, 'tkhd');
    ignored.push({
      id: read32(tkhd, tkhd[0] === 1 ? 20 : 12),
      format: entries.map((e) => e.type).join(','),
    });
    neutralize(data, moov, trak);
  }
  if (!ignored.length) return { data: input, ignored };
  const ids = new Set(ignored.map((t) => t.id));
  for (const mvex of boxes(moov).filter((b) => b.type === 'mvex'))
    for (const trex of boxes(mvex.body).filter((b) => b.type === 'trex'))
      if (ids.has(read32(trex.body, 4))) neutralize(data, mvex.body, trex);
  return { data, ignored };
}
export function filterCaptionMedia(
  input: Uint8Array,
  ignored: IgnoredCaptionTrack[],
) {
  if (!ignored.length) return input;
  const data = input.slice(),
    ids = new Set(ignored.map((t) => t.id));
  for (const moof of boxes(data).filter((b) => b.type === 'moof')) {
    const fragments = boxes(moof.body).filter((b) => b.type === 'traf');
    const excluded = fragments.filter((traf) =>
      ids.has(read32(child(traf.body, 'tfhd'), 4)),
    );
    if (fragments.length && excluded.length === fragments.length)
      neutralize(data, data, moof);
    else for (const traf of excluded) neutralize(data, moof.body, traf);
  }
  return data;
}
