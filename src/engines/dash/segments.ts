import type { Period, Representation, SegmentReference } from './model';
import { resolveUrl } from './mpd';

export function expandTemplate(
  template: string,
  representation: Representation,
  number?: bigint,
  time?: bigint,
) {
  const result = template.replace(
    /\$\$|\$([A-Za-z]+)(?:%0(\d+)([diouxX]))?\$/g,
    (token, name, width, format) => {
      if (token === '$$') return '\u0000';
      const values: Record<string, string | bigint | undefined> = {
        RepresentationID: representation.id,
        Bandwidth: BigInt(representation.bandwidth),
        Number: number,
        Time: time,
      };
      const value = values[name];
      if (value === undefined)
        throw new Error(`Unavailable DASH template identifier ${name}`);
      if (name === 'RepresentationID' && width)
        throw new Error('DASH RepresentationID cannot have a numeric format');
      if (width && Number(width) > 32)
        throw new Error('DASH template padding limit');
      let text =
        typeof value === 'bigint'
          ? value.toString(
              format === 'x' || format === 'X' ? 16 : format === 'o' ? 8 : 10,
            )
          : value;
      if (format === 'X') text = text.toUpperCase();
      return width ? text.padStart(Number(width), '0') : text;
    },
  );
  if (result.includes('$'))
    throw new Error('Unsupported DASH template expression');
  return result.replaceAll('\u0000', '$');
}
export function initializationResource(rep: Representation) {
  const a = rep.address;
  if (a.initialization === undefined)
    throw new Error('DASH initialization segment is required');
  return {
    url: resolveUrl(expandTemplate(a.initialization, rep), rep.baseUrls[0]),
    ...(rep.baseUrls.length > 1
      ? {
          alternatives: rep.baseUrls
            .slice(1)
            .map((base) =>
              resolveUrl(expandTemplate(a.initialization!, rep), base),
            ),
        }
      : {}),
    range: a.initializationRange,
  };
}
const floorDiv = (a: bigint, b: bigint) => (a >= 0n ? a / b : (a - b + 1n) / b);
const ceilDiv = (a: bigint, b: bigint) => -floorDiv(-a, b);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
/** Generate only the requested interval, including million-repeat live timelines. */
export function segmentReferences(
  rep: Representation,
  period: Period,
  from: number,
  to: number,
): SegmentReference[] {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const a = rep.address;
  if (a.kind === 'base')
    throw new Error('DASH SegmentBase requires a resolved SIDX');
  const low =
    BigInt(Math.floor((from - period.start) * a.timescale)) +
    a.presentationTimeOffset;
  const high =
    BigInt(Math.ceil((to - period.start) * a.timescale)) +
    a.presentationTimeOffset;
  const periodEnd =
    period.duration === undefined
      ? undefined
      : a.presentationTimeOffset +
        BigInt(Math.ceil(period.duration * a.timescale));
  const limit = periodEnd === undefined ? high : min(high, periodEnd);
  const out: SegmentReference[] = [];
  let cursor = 0n,
    index = 0n;
  const emit = (time: bigint, d: bigint, i: bigint) => {
    const start =
      period.start + Number(time - a.presentationTimeOffset) / a.timescale;
    const end =
      period.start + Number(time + d - a.presentationTimeOffset) / a.timescale;
    if (
      end <= period.start ||
      (period.duration !== undefined && start >= period.start + period.duration)
    )
      return;
    const number = a.startNumber + i;
    const resource = a.kind === 'list' ? a.urls?.[Number(i)] : undefined;
    if (a.kind === 'list' && !resource)
      throw new Error('DASH SegmentList and timeline lengths disagree');
    if (a.kind === 'template' && !a.media)
      throw new Error('DASH SegmentTemplate needs media');
    out.push({
      number,
      time,
      start,
      end:
        period.duration === undefined
          ? end
          : Math.min(end, period.start + period.duration),
      url: resolveUrl(
        resource
          ? resource.media
          : expandTemplate(
              a.media!,
              rep,
              number,
              a.timeline ? time : time - a.eptDelta,
            ),
        rep.baseUrls[0],
      ),
      ...(rep.baseUrls.length > 1
        ? {
            alternatives: rep.baseUrls
              .slice(1)
              .map((base) =>
                resolveUrl(
                  resource
                    ? resource.media
                    : expandTemplate(
                        a.media!,
                        rep,
                        number,
                        a.timeline ? time : time - a.eptDelta,
                      ),
                  base,
                ),
              ),
          }
        : {}),
      range: resource?.range,
    });
    if (out.length > 10000)
      throw new Error('DASH requested segment window exceeds limit');
  };
  const entries =
    a.timeline ??
    (a.duration
      ? [
          {
            time: a.presentationTimeOffset + a.eptDelta,
            duration: a.duration,
            repeat: -1,
          },
        ]
      : undefined);
  if (!entries?.length)
    throw new Error('DASH segments need duration or SegmentTimeline');
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    const entry = entries[entryIndex];
    if (entry.time !== undefined) {
      if (entryIndex > 0 && entry.time < cursor)
        throw new Error('Overlapping DASH SegmentTimeline entries');
      cursor = entry.time;
    }
    const nextTime = entries[entryIndex + 1]?.time;
    let count =
      entry.repeat >= 0
        ? BigInt(entry.repeat) + 1n
        : max(
            0n,
            ceilDiv((nextTime ?? periodEnd ?? high) - cursor, entry.duration),
          );
    if (
      entry.repeat === -1 &&
      entryIndex + 1 < entries.length &&
      nextTime === undefined
    )
      throw new Error('Unbounded DASH repeat needs a following explicit time');
    if (a.kind === 'list')
      count = min(count, BigInt(a.urls?.length ?? 0) - index);
    const first = min(count, max(0n, floorDiv(low - cursor, entry.duration)));
    const last = min(count, max(0n, ceilDiv(limit - cursor, entry.duration)));
    if (last - first > 10000n)
      throw new Error('DASH requested segment window exceeds limit');
    for (let i = first; i < last; i++)
      emit(cursor + i * entry.duration, entry.duration, index + i);
    cursor += count * entry.duration;
    index += count;
    if (cursor >= limit) break;
  }
  return out;
}
