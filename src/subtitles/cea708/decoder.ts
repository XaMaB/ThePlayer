import {
  fragmentMetadata,
  fragmentSamples,
} from '../../engines/hls/fragment-samples';
import { mp4SeiCaptions } from '../../engines/hls/cea-sei';
import { Cea708Timeline } from '../../engines/hls/cea708-timeline';
import type { P16Encoding } from '../../engines/hls/cea708-packets';
import type { Screen708 } from '../../engines/hls/cea708-service';

export interface CaptionService {
  language?: string;
  label?: string;
  encoding?: string;
}
interface CaptionTrack {
  name: string;
  service: number;
  format: string;
  language: string;
  label: string;
  inband: boolean;
}
const cueFromScreen = (screen: Screen708) => {
  const windows = screen.windows
    .filter((w) => w.visible)
    .map((w) => ({
      id: w.id,
      priority: w.priority,
      relative: w.relative,
      anchorPoint: w.anchor,
      anchorHorizontal: w.horizontal,
      anchorVertical: w.vertical,
      rowCount: w.rows,
      columnCount: w.columns,
      pen: { penSize: w.pen.size },
      attributes: { justify: w.justify },
      rows: w.cells.map((row) =>
        row
          .map((cell) => cell?.text ?? ' ')
          .join('')
          .trimEnd(),
      ),
    }));
  return {
    pts: screen.time,
    duration: 30,
    text: windows
      .map((w) => w.rows.join('\n').trimEnd())
      .filter(Boolean)
      .join('\n'),
    windows,
    rects: [],
    width: 0,
    height: 0,
  };
};
type Cue = ReturnType<typeof cueFromScreen>;
/** Original MP4/SEI + CEA-708 core, shared with HLS/DASH. MoQ timestamps remain absolute. */
export class Cea708Decoder {
  private metadata;
  private timeline: Cea708Timeline;
  private period = 0;
  private lastStart = -Infinity;
  readonly tracks = new Map<string, CaptionTrack>();
  private cues = new Map<string, Cue[]>();
  constructor(
    initialization: Uint8Array,
    private services: Record<string, CaptionService> = {},
  ) {
    this.metadata = fragmentMetadata(initialization);
    const encodings: Record<number, P16Encoding> = {};
    for (const [key, service] of Object.entries(services)) {
      const match = /^SERVICE([1-9][0-9]?)$/.exec(key);
      if (!match || Number(match[1]) > 63) continue;
      const encoding = service.encoding?.toLowerCase() ?? 'unicode';
      if (!['unicode', 'euc-kr', 'gbk', 'big5'].includes(encoding))
        throw new Error('Unsupported CEA-708 P16 encoding: ' + encoding);
      encodings[Number(match[1])] = encoding as P16Encoding;
    }
    this.timeline = new Cea708Timeline(encodings);
  }
  push(fragment: Uint8Array, currentTime?: number) {
    // Parse fully before updating state: a truncated fragment must not poison the decoder.
    const samples = fragmentSamples(fragment, this.metadata).filter(
      (s) => s.track.video,
    );
    if (!samples.length) return [];
    const start = samples.reduce(
      (value, s) => Math.min(value, s.time),
      Infinity,
    );
    const end = samples.reduce(
      (value, s) => Math.max(value, s.time + s.duration),
      -Infinity,
    );
    const packets = mp4SeiCaptions(fragment, this.metadata);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
      throw new Error('Invalid MoQ caption timeline');
    const rewound = start < this.lastStart - 0.1;
    if (rewound) {
      this.timeline.reset();
      this.cues.clear();
      this.period++;
    }
    this.lastStart = start;
    this.timeline.update(
      packets,
      0,
      start,
      end,
      this.period,
      Math.max(currentTime ?? start, start - 120),
    );
    const events: {
      track: CaptionTrack;
      cue: Cue;
      replaceFrom?: number;
    }[] = [];
    if (rewound)
      for (const track of this.tracks.values())
        events.push({
          track,
          replaceFrom: 0,
          cue: {
            pts: start,
            duration: 30,
            text: '',
            windows: [],
            rects: [],
            width: 0,
            height: 0,
          },
        });
    const snapshots = new Map<number, Cue[]>();
    const cutoff = this.timeline.events[0]?.time ?? start;
    for (const screen of this.timeline.events) {
      const list = snapshots.get(screen.service) ?? [];
      if (!screen.checkpoint) list.push(cueFromScreen(screen));
      snapshots.set(screen.service, list);
    }
    for (const [service, snapshotsForService] of snapshots) {
      const name = 'cea708-' + service;
      let track = this.tracks.get(name);
      if (!track) {
        const settings = this.services['SERVICE' + service] ?? {};
        track = {
          name,
          service,
          format: 'cea-708',
          language: settings.language ?? 'und',
          label: settings.label ?? 'Service ' + service,
          inband: true,
        };
        this.tracks.set(name, track);
      }
      const previous = this.cues.get(name) ?? [];
      const history = [
        ...previous.filter((c) => c.pts < cutoff),
        ...snapshotsForService,
      ]
        .sort((a, b) => a.pts - b.pts)
        .slice(-200);
      const changed = history.filter(
        (c) =>
          !previous.some(
            (old) =>
              old.pts === c.pts && JSON.stringify(old) === JSON.stringify(c),
          ),
      );
      const removed = previous.filter(
        (c) =>
          c.pts >= Math.max(cutoff, history[0]?.pts ?? cutoff) &&
          !history.some((next) => next.pts === c.pts),
      );
      if (removed.length) {
        const from = Math.min(
          ...removed.map((c) => c.pts),
          ...changed.map((c) => c.pts),
        );
        const replacement = history.filter((c) => c.pts >= from);
        if (!replacement.some((c) => c.pts === from)) {
          const active = history.filter((c) => c.pts < from).at(-1);
          replacement.unshift(
            active
              ? { ...active, pts: from }
              : {
                  pts: from,
                  duration: 30,
                  text: '',
                  windows: [],
                  rects: [],
                  width: 0,
                  height: 0,
                },
          );
        }
        replacement.forEach((cue, i) =>
          events.push({
            track: track!,
            cue,
            ...(i === 0 ? { replaceFrom: from } : {}),
          }),
        );
      } else for (const cue of changed) events.push({ track, cue });
      this.cues.set(name, history);
    }
    return events;
  }
  get errors() {
    return this.timeline.errors;
  }
  history(name: string) {
    return this.cues.get(name) ?? [];
  }
}
