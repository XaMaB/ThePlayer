/** Account for frame-sized gaps without downloading the entire remaining playlist. */
export function bufferedAhead(ranges: TimeRanges, time: number): number {
  for (let i = 0; i < ranges.length; i++) {
    if (time < ranges.start(i) - 0.1 || time > ranges.end(i)) continue;
    let end = ranges.end(i);
    while (i + 1 < ranges.length && ranges.start(i + 1) - end <= 0.1)
      end = ranges.end(++i);
    return Math.max(0, end - time);
  }
  return 0;
}
/** Only recover tiny holes at a buffered boundary; never skip missing content. */
export function nextGapPosition(
  ranges: TimeRanges,
  time: number,
): number | undefined {
  for (let i = 1; i < ranges.length; i++) {
    const end = ranges.end(i - 1),
      start = ranges.start(i);
    if (time >= end - 0.05 && time < start && start - end <= 0.1)
      return start + 0.001;
  }
}
