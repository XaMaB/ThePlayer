/** Generate legal multi-packet PMTs without changing elementary media payloads. */
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte << 24;
    for (let i = 0; i < 8; i++)
      value = (value << 1) ^ (value & 0x80000000 ? 0x04c11db7 : 0);
  }
  return value >>> 0;
}
export function expandedPsi(bytes) {
  const output = [];
  let pmt = -1,
    continuity = 0;
  for (let at = 0; at < bytes.length; at += 188) {
    const packet = bytes.subarray(at, at + 188);
    const pid = ((packet[1] & 31) << 8) | packet[2];
    const offset = packet[3] & 0x20 ? 5 + packet[4] : 4;
    const payload = packet.subarray(offset);
    if (pid === 0 && packet[1] & 0x40) {
      const pat = payload.subarray(1 + payload[0]);
      pmt = ((pat[10] & 31) << 8) | pat[11];
    }
    if (pid !== pmt) {
      output.push(packet);
      continue;
    }
    const old = payload.subarray(1 + payload[0]);
    const size = 3 + ((old[1] & 15) << 8) + old[2];
    const descriptor = Buffer.concat([
      Buffer.from([0x80, 180]),
      Buffer.alloc(180),
    ]);
    const section = Buffer.concat([
      old.subarray(0, 12),
      descriptor,
      old.subarray(12, size - 4),
      Buffer.alloc(4),
    ]);
    const infoLength = ((old[10] & 15) << 8) + old[11] + descriptor.length;
    section[10] = (section[10] & 0xf0) | (infoLength >> 8);
    section[11] = infoLength & 255;
    section[1] = (section[1] & 0xf0) | ((section.length - 3) >> 8);
    section[2] = (section.length - 3) & 255;
    section.writeUInt32BE(crc(section.subarray(0, -4)), section.length - 4);
    let cursor = 0;
    while (cursor < section.length) {
      const next = Buffer.alloc(188, 255);
      next.set([
        0x47,
        (pid >> 8) | (cursor === 0 ? 0x40 : 0),
        pid & 255,
        0x10 | (continuity++ & 15),
      ]);
      const begin = cursor === 0 ? 5 : 4;
      if (!cursor) next[4] = 0;
      const length = Math.min(188 - begin, section.length - cursor);
      next.set(section.subarray(cursor, cursor + length), begin);
      cursor += length;
      output.push(next);
    }
  }
  if (pmt < 0) throw new Error('Fixture needs a PAT');
  return Buffer.concat(output);
}
