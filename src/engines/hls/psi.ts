/** MPEG-2 PSI sections: pointer fields, packet spanning, stuffing and CRC-32/MPEG-2. */
export function psiCrc(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0);
  }
  return crc >>> 0;
}
export class PsiAssembler {
  private pending = new Uint8Array(0);
  reset() {
    this.pending = new Uint8Array(0);
  }
  push(payload: Uint8Array, start: boolean): Uint8Array[] {
    const sections: Uint8Array[] = [];
    const feed = (part: Uint8Array) => {
      const data = new Uint8Array(this.pending.length + part.length);
      data.set(this.pending);
      data.set(part, this.pending.length);
      let at = 0;
      while (at < data.length && data[at] !== 0xff) {
        if (data.length - at < 3) break;
        const length = 3 + ((data[at + 1] & 15) << 8) + data[at + 2];
        if (!(data[at + 1] & 0x80) || length < 12 || length > 1024)
          throw new Error('Invalid PAT/PMT section length');
        if (data.length - at < length) break;
        const section = data.slice(at, at + length);
        if (psiCrc(section) !== 0) throw new Error('Invalid PSI CRC');
        sections.push(section);
        at += length;
      }
      this.pending = data[at] === 0xff ? new Uint8Array(0) : data.slice(at);
    };
    if (start) {
      if (!payload.length || payload[0] >= payload.length)
        throw new Error('Invalid PSI pointer');
      const boundary = payload[0] + 1;
      if (this.pending.length) {
        feed(payload.subarray(1, boundary));
        if (this.pending.length)
          throw new Error('Truncated PSI section before pointer boundary');
      }
      feed(payload.subarray(boundary));
    } else if (this.pending.length) feed(payload);
    return sections;
  }
}
/** Publish only complete current tables; never mix sections from different versions. */
export class PsiTable {
  private key = '';
  private sections = new Map<number, Uint8Array>();
  accept(section: Uint8Array): Uint8Array[] | undefined {
    if (!(section[5] & 1)) return;
    const number = section[6],
      last = section[7];
    if (number > last) throw new Error('Invalid PSI section numbering');
    const key = [
      section[0],
      section[3],
      section[4],
      section[5] >> 1,
      last,
    ].join(':');
    if (key !== this.key) {
      this.key = key;
      this.sections.clear();
    }
    const old = this.sections.get(number);
    if (
      old &&
      (old.length !== section.length || old.some((b, i) => b !== section[i]))
    )
      throw new Error('PSI changed without a version update');
    this.sections.set(number, section);
    if (this.sections.size !== last + 1) return;
    return Array.from({ length: last + 1 }, (_, i) => this.sections.get(i)!);
  }
}
