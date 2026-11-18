import {
  fragmentMetadata,
  fragmentSamples,
  type FragmentTrack,
} from '../hls/fragment-samples';
import { mp4SeiCaptions } from '../hls/cea-sei';
import { Cea608Timeline } from '../hls/cea608-timeline';
import { Cea708Timeline } from '../hls/cea708-timeline';
import { Cea608Renderer } from '../hls/cea608-renderer';
import { Cea708Renderer } from '../hls/cea708-renderer';
import type { P16Encoding } from '../hls/cea708-packets';
export interface CaptionTrack {
  name: string;
  format: string;
  service: number;
  label: string;
  language: string;
  inband: boolean;
}
/** Clear AVC/HEVC ATSC captions share the original HLS decoders and bounded histories. */
export class DashCaptions {
  readonly tracks: CaptionTrack[] = [];
  private analog = new Cea608Timeline();
  private digital: Cea708Timeline;
  private renderer?: Cea608Renderer | Cea708Renderer;
  private selected = '';
  private period = '';
  private serial = 0;
  private received = new Map<string, number>();
  private displayed = 0;
  private receivedCount = 0;
  private previous = '';
  constructor(
    private video: HTMLVideoElement,
    encodings: Record<number, P16Encoding> | undefined,
    private emit: (event: string, detail: unknown) => void,
  ) {
    this.digital = new Cea708Timeline(encodings);
  }
  metadata(init: Uint8Array) {
    return fragmentMetadata(init);
  }
  consume(
    data: Uint8Array,
    metadata: FragmentTrack[],
    offset: number,
    period: string,
    resourceOffset = 0,
  ) {
    try {
      const samples = fragmentSamples(data, metadata, resourceOffset).filter(
        (s) => s.track.video,
      );
      if (!samples.length) return;
      const start = Math.min(...samples.map((s) => s.time)) + offset;
      const end = Math.max(...samples.map((s) => s.time + s.duration)) + offset;
      const packets = mp4SeiCaptions(data, metadata, resourceOffset);
      if (this.period !== period) {
        this.period = period;
        this.serial++;
      }
      this.analog.update(
        packets
          .filter((p) => p.type < 2)
          .map((p) => ({
            time: p.time,
            first: p.first,
            second: p.second,
            field: (p.type + 1) as 1 | 2,
          })),
        offset,
        start,
        end,
        this.serial,
        this.video.currentTime,
      );
      this.digital.update(
        packets.filter((p) => p.type >= 2),
        offset,
        start,
        end,
        this.serial,
        this.video.currentTime,
      );
      let added = false;
      for (const [format, events] of [
        ['cea-608', this.analog.events.filter((e) => e.rows.length)],
        ['cea-708', this.digital.events.filter((e) => e.windows.length)],
      ] as const) {
        for (const e of events) {
          const name = `dash-${format}-${e.service}`;
          if (!this.tracks.some((t) => t.name === name)) {
            this.tracks.push({
              name,
              format,
              service: e.service,
              label:
                format === 'cea-608'
                  ? `CC${e.service}`
                  : `Service ${e.service}`,
              language: 'und',
              inband: true,
            });
            added = true;
          }
          if (!e.checkpoint && !this.received.has(`${name}:${e.time}`)) {
            this.received.set(`${name}:${e.time}`, e.time);
            this.receivedCount++;
          }
        }
      }
      for (const [key, time] of this.received)
        if (time < this.video.currentTime - 35) this.received.delete(key);
      if (added) this.emit('captiontracks', this.tracks);
      this.render();
    } catch (error) {
      this.emit(
        'captionwarning',
        new Error('DASH in-band captions could not be decoded', {
          cause: error,
        }),
      );
    }
  }
  select(name: string) {
    this.renderer?.destroy();
    this.renderer = undefined;
    this.selected = name;
    this.previous = '';
    const track = this.tracks.find((t) => t.name === name);
    if (!track) return;
    const present = (text: string) => {
      if (text && text !== this.previous) this.displayed++;
      this.previous = text;
      this.emit('subtitlemetrics', {
        received: this.receivedCount,
        displayed: this.displayed,
      });
    };
    this.renderer =
      track.format === 'cea-608'
        ? new Cea608Renderer(this.video, present)
        : new Cea708Renderer(this.video, present);
    this.render();
  }
  private render() {
    const track = this.tracks.find((t) => t.name === this.selected);
    if (!track || !this.renderer) return;
    if (track.format === 'cea-608')
      (this.renderer as Cea608Renderer).set([
        ...this.analog.events.filter((e) => e.service === track.service),
        { time: this.analog.horizon, service: track.service, rows: [] },
      ]);
    else
      (this.renderer as Cea708Renderer).set(
        this.digital.events.filter((e) => e.service === track.service),
      );
  }
  reset() {
    this.analog.reset();
    this.digital.reset();
    this.received.clear();
    this.select(this.selected);
  }
  destroy() {
    this.renderer?.destroy();
    this.analog.reset();
    this.digital.reset();
  }
}
