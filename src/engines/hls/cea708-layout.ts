import type { Window708, Cell708 } from './cea708-service';
export interface Visibility708 {
  start: number;
  duration: number;
  from: number;
  to: number;
  effect: number;
  direction: number;
}
export function visibility708(window: Window708, time: number) {
  const v = window.visibility;
  if (!v) return window.visible ? 1 : 0;
  const progress = Math.max(0, Math.min(1, (time - v.start) / v.duration));
  return v.from + (v.to - v.from) * progress;
}
/** Expand inter-word space for FULL; preserve source cells for other alignments. */
export function columns708(
  row: (Cell708 | null)[],
  columns: number,
  justify: number,
) {
  const occupied = (cell: Cell708 | null) =>
    cell !== null && (justify !== 3 || cell.text !== ' ');
  const first = row.findIndex(occupied),
    last = row.findLastIndex(occupied);
  if (first < 0) return [];
  const shift =
    justify === 1
      ? columns - last - 1
      : justify === 2
        ? (columns - (last - first + 1)) / 2 - first
        : 0;
  if (justify !== 3) return row.map((_, i) => i + shift);
  const gaps = row
    .slice(first, last + 1)
    .filter((cell) => !cell || cell.text === ' ').length;
  const extra = Math.max(0, columns - (last - first + 1));
  let offset = gaps ? -first : (columns - (last - first + 1)) / 2 - first;
  return row.map((cell, i) => {
    const position = i + offset;
    if (gaps && i >= first && i <= last && (!cell || cell.text === ' '))
      offset += extra / gaps;
    return position;
  });
}
export function wipe708(window: Window708, amount: number) {
  const transition = window.visibility;
  if (transition?.effect !== 2) return '';
  const hidden = Math.max(0, Math.min(100, (1 - amount) * 100));
  const hiding = transition.to === 0;
  // Show reveals in the declared direction; hide removes in that direction.
  const side =
    (hiding ? [3, 1, 0, 2] : [1, 3, 2, 0])[transition.direction] ?? 1;
  const edges = [0, 0, 0, 0];
  edges[side] = hidden;
  return `inset(${edges.map((v) => v + '%').join(' ')})`;
}
