import { Cea608Decoder, type Screen608 } from './cea608';
import type { CaptionPacket } from './c608-mp4';
interface Packet extends CaptionPacket {
  reset?: boolean;
}
/** Checkpoint decoder state while retaining enough history for the media back buffer. */
export class Cea608Timeline {
  private base = new Cea608Decoder();
  private packets: Packet[] = [];
  private baseTime = 0;
  private period = -1;
  events: Screen608[] = [];
  parityErrors = 0;
  horizon = 0;
  reset() {
    this.base = new Cea608Decoder();
    this.packets = [];
    this.events = [];
    this.baseTime = 0;
    this.period = -1;
    this.horizon = 0;
  }
  update(
    input: CaptionPacket[],
    offset: number,
    start: number,
    end: number,
    period: number,
    currentTime: number,
    replaceFuture = false,
  ) {
    if (start < this.baseTime) this.reset();
    this.horizon = replaceFuture ? end : Math.max(this.horizon, end);
    const reset =
      this.period !== period ||
      this.packets.some((p) => p.reset && Math.abs(p.time - start) < 0.001);
    this.period = period;
    this.packets = this.packets.filter(
      (p) => p.time < start || (!replaceFuture && p.time >= end),
    );
    if (reset)
      this.packets.push({ time: start, first: 0, second: 0, reset: true });
    this.packets.push(...input.map((p) => ({ ...p, time: p.time + offset })));
    this.packets.sort(
      (a, b) => a.time - b.time || Number(!!b.reset) - Number(!!a.reset),
    );
    const cutoff = Math.max(this.baseTime, currentTime - 35);
    const consume = (decoder: Cea608Decoder, p: Packet) => {
      if (p.reset) {
        decoder.reset();
        return decoder.screens(p.time);
      }
      return decoder.push(p.first, p.second, p.time);
    };
    for (const p of this.packets) if (p.time < cutoff) consume(this.base, p);
    this.packets = this.packets.filter((p) => p.time >= cutoff);
    this.baseTime = cutoff;
    const decoder = this.base.clone();
    this.events = decoder
      .screens(cutoff)
      .map((e) => ({ ...e, checkpoint: true }));
    for (const p of this.packets) this.events.push(...consume(decoder, p));
    this.parityErrors = decoder.parityErrors;
  }
}
