import type { CcData } from './cea-sei';
import { DtvccPackets, type P16Encoding } from './cea708-packets';
import { Cea708Service, type Screen708 } from './cea708-service';
interface Packet extends CcData {
  reset?: boolean;
  owner?: number;
}
class Decoder708 {
  packets = new DtvccPackets();
  services = new Map<number, Cea708Service>();
  constructor(private encodings: Record<number, P16Encoding>) {}
  clone() {
    const copy = new Decoder708(this.encodings);
    copy.packets = this.packets.clone();
    copy.services = new Map(
      [...this.services].map(([id, service]) => [id, service.clone()]),
    );
    return copy;
  }
  screens(time: number) {
    return [...this.services.values()].map((s) => s.screen(time));
  }
  advance(time: number) {
    return [...this.services.values()].flatMap((s) => s.advance(time));
  }
  consume(packet: Packet): Screen708[] {
    const events: Screen708[] = [];
    const result = packet.reset
      ? { reset: true, blocks: [] }
      : this.packets.push(packet);
    if (packet.reset) this.packets.reset();
    if (result.reset) {
      events.push(...this.advance(packet.time));
      for (const service of this.services.values()) service.reset();
      events.push(...this.screens(packet.time));
    }
    for (const block of result.blocks) {
      let service = this.services.get(block.service);
      if (!service) {
        service = new Cea708Service(
          block.service,
          this.encodings[block.service],
        );
        this.services.set(block.service, service);
      }
      events.push(...service.push(block.data, block.time));
    }
    return events;
  }
}
/** Replays a bounded back-buffer from a decoder checkpoint, including delayed commands. */
export class Cea708Timeline {
  private base: Decoder708;
  private packets: Packet[] = [];
  private baseTime = 0;
  private period = -1;
  events: Screen708[] = [];
  horizon = 0;
  errors = 0;
  constructor(private encodings: Record<number, P16Encoding> = {}) {
    this.base = new Decoder708(encodings);
  }
  reset() {
    this.base = new Decoder708(this.encodings);
    this.packets = [];
    this.events = [];
    this.baseTime = 0;
    this.period = -1;
    this.horizon = 0;
    this.errors = 0;
  }
  update(
    input: CcData[],
    offset: number,
    start: number,
    end: number,
    period: number,
    currentTime: number,
    replaceFuture = false,
  ) {
    if (start < this.baseTime) this.reset();
    this.horizon = replaceFuture ? end : Math.max(end, this.horizon);
    const reset =
      this.period !== period ||
      this.packets.some((p) => p.reset && Math.abs(p.time - start) < 0.001);
    this.period = period;
    this.packets = this.packets.filter(
      (p) => p.owner !== start && (!replaceFuture || p.time < start),
    );
    if (reset)
      this.packets.push({
        time: start,
        type: 0,
        first: 0,
        second: 0,
        owner: start,
        reset: true,
      });
    this.packets.push(
      ...input.map((p) => ({ ...p, owner: start, time: p.time + offset })),
    );
    this.packets.sort(
      (a, b) => a.time - b.time || Number(!!b.reset) - Number(!!a.reset),
    );
    const cutoff = Math.max(this.baseTime, currentTime - 35);
    for (const packet of this.packets)
      if (packet.time < cutoff) this.base.consume(packet);
    this.base.advance(cutoff);
    this.packets = this.packets.filter((p) => p.time >= cutoff);
    this.baseTime = cutoff;
    const decoder = this.base.clone();
    const events = decoder
      .screens(cutoff)
      .map((e) => ({ ...e, checkpoint: true }) as Screen708);
    for (const packet of this.packets) events.push(...decoder.consume(packet));
    events.push(...decoder.advance(this.horizon));
    events.sort((a, b) => a.time - b.time);
    // A frame may contain several service blocks; retain the final screen at that time.
    this.events = [];
    const last = new Map<
      number,
      { time: number; value: string; index: number }
    >();
    for (const event of events) {
      const value = JSON.stringify(event.windows),
        previous = last.get(event.service);
      if (previous?.time === event.time) {
        this.events[previous.index] = event;
        previous.value = value;
      } else if (previous?.value !== value) {
        last.set(event.service, {
          time: event.time,
          value,
          index: this.events.length,
        });
        this.events.push(event);
      }
    }
    this.errors =
      decoder.packets.errors +
      [...decoder.services.values()].reduce((sum, s) => sum + s.errors, 0);
  }
}
