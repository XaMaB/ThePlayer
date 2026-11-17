import type { CcData } from './cea-sei';

export interface ServiceBlock708 {
  service: number;
  time: number;
  data: Uint8Array;
}
export interface PacketResult708 {
  reset: boolean;
  blocks: ServiceBlock708[];
}

/** DTVCC packet and service framing, CTA-708 sections 5–6. */
export class DtvccPackets {
  private bytes: number[] = [];
  private expected = 0;
  private sequence = -1;
  private time = 0;
  errors = 0;

  reset() {
    this.bytes = [];
    this.expected = 0;
    this.sequence = -1;
  }

  clone() {
    const copy = new DtvccPackets();
    copy.bytes = [...this.bytes];
    copy.expected = this.expected;
    copy.sequence = this.sequence;
    copy.time = this.time;
    copy.errors = this.errors;
    return copy;
  }

  push(packet: CcData): PacketResult708 {
    const result: PacketResult708 = { reset: false, blocks: [] };
    if (packet.type < 2) return result;
    if (packet.type === 3) {
      const sequence = packet.first >>> 6;
      if (
        this.expected ||
        (this.sequence >= 0 && sequence !== (this.sequence + 1) % 4)
      ) {
        this.errors++;
        result.reset = true;
      }
      this.sequence = sequence;
      this.expected = (packet.first & 63 || 64) * 2 - 1;
      this.bytes = [packet.second];
      this.time = packet.time;
    } else {
      // Joining mid-packet is normal; wait for a packet start.
      if (!this.expected) return result;
      this.bytes.push(packet.first, packet.second);
    }
    if (this.bytes.length < this.expected) return result;
    const data = Uint8Array.from(this.bytes);
    this.bytes = [];
    this.expected = 0;
    try {
      result.blocks = serviceBlocks708(data, this.time);
    } catch {
      this.errors++;
      result.reset = true;
    }
    return result;
  }
}

export function serviceBlocks708(
  data: Uint8Array,
  time: number,
): ServiceBlock708[] {
  const blocks: ServiceBlock708[] = [];
  let at = 0;
  while (at < data.length) {
    const header = data[at++],
      size = header & 31;
    let service = header >>> 5;
    if (!service) {
      if (size) throw new Error('Invalid DTVCC null service');
      continue;
    }
    if (!size) throw new Error('Empty DTVCC service block');
    if (service === 7) {
      if (at >= data.length || data[at] & 0xc0 || (data[at] & 63) < 7)
        throw new Error('Invalid DTVCC extended service');
      service = data[at++] & 63;
    }
    if (at + size > data.length)
      throw new Error('Truncated DTVCC service block');
    blocks.push({ service, time, data: data.slice(at, at + size) });
    at += size;
  }
  return blocks;
}

/** Length-aware command parsing prevents parameter bytes becoming commands. */
export function commandLength708(
  data: readonly number[],
  at = 0,
): number | undefined {
  const code = data[at];
  if (code === undefined) return undefined;
  let length = 1;
  if (code === 0x10) {
    const ext = data[at + 1];
    if (ext === undefined) return undefined;
    length = ext < 0x20 ? 2 + (ext >>> 3) : 2;
    if (ext >= 0x80 && ext < 0x90) length = ext < 0x88 ? 6 : 7;
    if (ext >= 0x90 && ext < 0xa0) {
      if (data[at + 2] === undefined) return undefined;
      length = 3 + (data[at + 2] & 63);
    }
  } else if (code < 0x20) {
    length = code >= 0x18 ? 3 : code >= 0x11 ? 2 : 1;
  } else if (code >= 0x80 && code <= 0x9f) {
    if (code >= 0x98) length = 7;
    else if (code === 0x97) length = 5;
    else if (code === 0x91) length = 4;
    else if (code === 0x90 || code === 0x92) length = 3;
    else if (code >= 0x88 && code <= 0x8d) length = 2;
  }
  return at + length <= data.length ? length : undefined;
}

export type P16Encoding = 'unicode' | 'euc-kr' | 'gbk' | 'big5';
export function p16Character(
  high: number,
  low: number,
  encoding: P16Encoding = 'unicode',
): string {
  if (!high)
    return low >= 0x20 && (low < 0x80 || low >= 0xa0)
      ? low === 0x7f
        ? '♪'
        : String.fromCharCode(low)
      : '\ufffd';
  if (encoding !== 'unicode') {
    try {
      const value = new TextDecoder(encoding, { fatal: true }).decode(
        Uint8Array.of(high, low),
      );
      return [...value].length === 1 &&
        !/[\u0000-\u001f\u007f-\u009f]/.test(value)
        ? value
        : '\ufffd';
    } catch {
      return '\ufffd';
    }
  }
  const value = high * 256 + low;
  return (value >= 0xd800 && value <= 0xdfff) || value >= 0xfffe
    ? '\ufffd'
    : String.fromCharCode(value);
}

const g2: Record<number, string> = {
  0x20: ' ',
  0x21: '\u00a0',
  0x25: '…',
  0x2a: 'Š',
  0x2c: 'Œ',
  0x30: '█',
  0x31: '‘',
  0x32: '’',
  0x33: '“',
  0x34: '”',
  0x35: '•',
  0x39: '™',
  0x3a: 'š',
  0x3c: 'œ',
  0x3d: '℠',
  0x3f: 'Ÿ',
  0x76: '⅛',
  0x77: '⅜',
  0x78: '⅝',
  0x79: '⅞',
  0x7a: '│',
  0x7b: '┐',
  0x7c: '└',
  0x7d: '─',
  0x7e: '┘',
  0x7f: '┌',
};
export function graphic708(
  command: readonly number[],
  encoding: P16Encoding,
): string | undefined {
  const code = command[0];
  if (code === 0x18) return p16Character(command[1], command[2], encoding);
  if (code === 0x10) {
    const ext = command[1];
    if (ext >= 0x20 && ext < 0x80) return g2[ext] ?? '_';
    if (ext >= 0xa0) return '_';
  }
  if (code >= 0x20 && (code < 0x80 || code >= 0xa0))
    return code === 0x7f ? '♪' : String.fromCharCode(code);
  return undefined;
}
