import type { Playlist } from './playlist';
/** HLS 2nd Edition Appendix C: estimate a blocking target beyond a cached edge. */
export function tuneInUrl(first: Playlist, additional: number) {
  const tail = first.segments.at(-1)!;
  const target = first.targetDuration,
    part = first.partTarget!;
  if (!Number.isFinite(additional) || additional < 0 || !target || !part)
    throw new Error('Invalid CDN tune-in target');
  const end =
    tail.part === undefined ? target : (tail.partOffset ?? 0) + tail.duration;
  const goal = end + additional;
  let sequence = tail.sequence + Math.floor(goal / target);
  let index = Math.ceil((goal % target) / part - 1e-9) - 1;
  if (index < 0) {
    sequence--;
    index = Math.ceil(target / part) - 1;
  }
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !Number.isSafeInteger(index) ||
    index < 0
  )
    throw new Error('CDN tune-in target exceeds sequence limits');
  const url = new URL(first.url);
  url.searchParams.delete('_HLS_skip');
  url.searchParams.set('_HLS_msn', String(sequence));
  url.searchParams.set('_HLS_part', String(index));
  return url.href;
}
export function advancedMedia(first: Playlist, current: Playlist) {
  const firstTail = first.segments.at(-1)!,
    currentTail = current.segments.at(-1)!;
  if (firstTail.programDateTime && currentTail.programDateTime)
    return (
      (Date.parse(currentTail.programDateTime) -
        Date.parse(firstTail.programDateTime)) /
        1000 +
      currentTail.duration -
      firstTail.duration
    );
  const overlap = current.segments.find(
    (s) =>
      s.sequence === firstTail.sequence &&
      s.discontinuity === firstTail.discontinuity,
  );
  if (!overlap) return undefined;
  const shift =
    firstTail.start -
    (firstTail.partOffset ?? 0) -
    overlap.start +
    (overlap.partOffset ?? 0);
  return (
    currentTail.start +
    currentTail.duration +
    shift -
    firstTail.start -
    firstTail.duration
  );
}
