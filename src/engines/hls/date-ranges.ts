import type { Attributes, Playlist } from './playlist';
export interface DateRange {
  id: string;
  class?: string;
  startDate: number;
  endDate?: number;
  duration?: number;
  plannedDuration?: number;
  endOnNext: boolean;
  cue: string[];
  attributes: Attributes;
  scte35: Record<string, Uint8Array>;
}
/** HLS dates without an explicit zone are UTC, independent of the host timezone. */
export function hlsDate(value: string) {
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d(?::?\d\d)?)?$/i.test(
      value,
    )
  )
    throw new Error('Invalid HLS date');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  )
    throw new Error('Invalid HLS calendar date');
  const normalized = value.replace(/([+-]\d\d)$/, '$1:00');
  const time = Date.parse(
    /(?:Z|[+-]\d\d:?\d\d)$/i.test(normalized) ? normalized : normalized + 'Z',
  );
  if (!Number.isFinite(time)) throw new Error('Invalid HLS date');
  return time;
}
export function parseDateRange(
  attributes: Attributes,
  previous?: DateRange,
): DateRange {
  if (!attributes.ID) throw new Error('Missing date range ID');
  for (const [key, value] of Object.entries(attributes))
    if (
      previous?.attributes[key] !== undefined &&
      previous.attributes[key] !== value
    )
      throw new Error('Conflicting date range attribute ' + key);
  const a = { ...previous?.attributes, ...attributes };
  if (!a['START-DATE']) throw new Error('Missing date range START-DATE');
  const startDate = hlsDate(a['START-DATE']),
    endDate = a['END-DATE'] === undefined ? undefined : hlsDate(a['END-DATE']);
  const seconds = (key: string) => {
    if (a[key] === undefined) return undefined;
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(a[key]))
      throw new Error('Invalid date range ' + key);
    const n = Number(a[key]);
    if (!Number.isFinite(n)) throw new Error('Invalid date range duration');
    return n;
  };
  const duration = seconds('DURATION'),
    plannedDuration = seconds('PLANNED-DURATION'),
    endOnNext = a['END-ON-NEXT'] === 'YES';
  if (a['END-ON-NEXT'] !== undefined && !endOnNext)
    throw new Error('Invalid END-ON-NEXT');
  if (
    endOnNext &&
    (!a.CLASS || duration !== undefined || endDate !== undefined)
  )
    throw new Error('Invalid END-ON-NEXT range');
  if (
    endDate !== undefined &&
    (endDate < startDate ||
      (duration !== undefined &&
        Math.abs(endDate - startDate - duration * 1000) > 0.5))
  )
    throw new Error('Inconsistent date range end');
  const cue = a.CUE?.split(',') ?? [];
  if (
    new Set(cue).size !== cue.length ||
    (cue.includes('PRE') && cue.includes('POST'))
  )
    throw new Error('Invalid date range CUE');
  const scte35: Record<string, Uint8Array> = {};
  for (const key of ['SCTE35-CMD', 'SCTE35-OUT', 'SCTE35-IN'])
    if (a[key] !== undefined) {
      if (!/^0x(?:[0-9a-f]{2})+$/i.test(a[key]))
        throw new Error('Invalid SCTE-35 hex data');
      scte35[key] = Uint8Array.from(a[key].slice(2).match(/../g)!, (v) =>
        parseInt(v, 16),
      );
    }
  return {
    id: a.ID,
    class: a.CLASS,
    startDate,
    endDate:
      endDate ??
      (duration === undefined ? undefined : startDate + duration * 1000),
    duration,
    plannedDuration,
    endOnNext,
    cue,
    attributes: a,
    scte35,
  };
}
export function finishDateRanges(
  ranges: DateRange[],
  warn: (message: string) => void,
) {
  const sorted = [...ranges].sort((a, b) => a.startDate - b.startDate);
  return sorted.filter((r, i) => {
    if (r.endOnNext) {
      const next = sorted
        .slice(i + 1)
        .find(
          (other) => other.class === r.class && other.startDate > r.startDate,
        );
      if (next) {
        r.endDate = next.startDate;
        r.duration = (next.startDate - r.startDate) / 1000;
      }
    }
    if (
      r.class &&
      sorted.some((other) => other.class === r.class && other.endOnNext)
    ) {
      const overlap = sorted
        .slice(0, i)
        .some(
          (other) =>
            other.class === r.class &&
            (other.endDate ?? Infinity) > r.startDate,
        );
      if (overlap) {
        warn('Overlapping END-ON-NEXT class ' + r.class);
        return false;
      }
    }
    return true;
  });
}
export interface TimedDateRange extends DateRange {
  start: number;
  end?: number;
}
export function timedDateRanges(p: Playlist): TimedDateRange[] {
  const anchors = [...p.segments, ...p.parts]
    .filter((s) => s.programDateTime)
    .map((s) => ({ time: hlsDate(s.programDateTime!), start: s.start }))
    .sort((a, b) => a.time - b.time);
  if (!anchors.length) return [];
  const position = (date: number) => {
    const a = anchors.findLast((a) => a.time <= date) ?? anchors[0];
    return a.start + (date - a.time) / 1000;
  };
  return (p.dateRanges ?? []).map((r) => ({
    ...r,
    start: position(r.startDate),
    end: r.endDate === undefined ? undefined : position(r.endDate),
  }));
}
export class DateRangeTimeline {
  private ranges: TimedDateRange[] = [];
  private versions = new Map<string, string>();
  private active = new Set<string>();
  private fired = new Set<string>();
  private once = new Set<string>();
  private last?: number;
  constructor(
    private emit: (name: string, detail: unknown) => void,
    private cueTime: (range: TimedDateRange) => number = (range) => range.start,
  ) {}
  /** Engine-directed resumption must not reset replay state like a user seek. */
  reposition(time: number) {
    this.last = time;
  }
  update(p: Playlist) {
    this.ranges = timedDateRanges(p);
    const current = new Set(this.ranges.map((r) => r.id));
    for (const id of this.versions.keys())
      if (!current.has(id)) {
        this.versions.delete(id);
        this.emit('daterangeremove', { id });
        this.fired.delete(id);
        if (this.active.delete(id))
          this.emit('daterangeexit', { id, removed: true });
      }
    for (const r of this.ranges) {
      const version = JSON.stringify(r.attributes);
      if (this.versions.get(r.id) !== version) {
        this.versions.set(r.id, version);
        this.emit('daterange', r);
      }
    }
    while (this.once.size > 4096)
      this.once.delete(this.once.values().next().value!);
  }
  restartPass() {
    this.fired.clear();
    this.last = undefined;
  }
  phase(phase: 'PRE' | 'POST') {
    for (const r of this.ranges)
      if (r.cue.includes(phase)) this.trigger(r, phase);
  }
  private trigger(r: TimedDateRange, cause: string, context = {}) {
    if (this.fired.has(r.id) || (r.cue.includes('ONCE') && this.once.has(r.id)))
      return;
    this.fired.add(r.id);
    if (r.cue.includes('ONCE')) this.once.add(r.id);
    this.emit('daterangecue', { ...r, cause, ...context });
  }
  tick(time: number, seeking = false) {
    const backwards = this.last !== undefined && time < this.last;
    for (const r of this.ranges) {
      if (backwards && time < r.start && !r.cue.includes('ONCE'))
        this.fired.delete(r.id);
      const inside = time >= r.start && (r.end === undefined || time < r.end);
      if (inside && !this.active.has(r.id)) {
        this.active.add(r.id);
        this.emit('daterangeenter', r);
      } else if (!inside && this.active.delete(r.id))
        this.emit('daterangeexit', r);
      const triggerTime = this.cueTime(r);
      const crossed =
        (this.last ?? -Infinity) < triggerTime && time >= triggerTime;
      const cueInside =
        time >= triggerTime && (r.end === undefined || time < r.end);
      if (
        !r.cue.includes('PRE') &&
        !r.cue.includes('POST') &&
        (cueInside || (crossed && !seeking))
      )
        this.trigger(r, seeking ? 'seek' : 'playback', {
          initial: this.last === undefined,
          position: time,
        });
    }
    this.last = time;
  }
}
