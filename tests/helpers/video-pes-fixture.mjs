/** Repacketize generated AVC fixtures while retaining their original coded pictures. */
function pts(d, at) {
  return (
    ((d[at] >> 1) & 7) * 2 ** 30 +
    d[at + 1] * 2 ** 22 +
    (d[at + 2] >> 1) * 2 ** 15 +
    d[at + 3] * 128 +
    (d[at + 4] >> 1)
  );
}
function removeAud(data, hevc) {
  const starts = [];
  for (let i = 0; i + 2 < data.length; i++)
    if (
      !data[i] &&
      !data[i + 1] &&
      (data[i + 2] === 1 || (!data[i + 2] && data[i + 3] === 1))
    ) {
      const header = i + (data[i + 2] === 1 ? 3 : 4);
      starts.push({ at: i, header });
      i = header - 1;
    }
  return Buffer.concat(
    starts
      .filter((s) =>
        hevc
          ? ((data[s.header] >> 1) & 63) !== 35
          : (data[s.header] & 31) !== 9,
      )
      .map((s) =>
        data.subarray(s.at, starts[starts.indexOf(s) + 1]?.at ?? data.length),
      ),
  );
}
export function videoPesFixture(input, mode, noAud = true) {
  const output = [],
    pes = [];
  let hevc = false;
  let current,
    pid = -1,
    pmt = -1;
  for (let at = 0; at < input.length; at += 188) {
    const packet = input.subarray(at, at + 188);
    const id = ((packet[1] & 31) << 8) | packet[2];
    const payload = packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
    if (id === 0 && packet[1] & 0x40) {
      const p = payload.subarray(1 + payload[0]);
      pmt = ((p[10] & 31) << 8) | p[11];
    }
    if (id === pmt && packet[1] & 0x40) {
      const p = payload.subarray(1 + payload[0]);
      let i = 12 + ((p[10] & 15) << 8) + p[11];
      const end = 3 + ((p[1] & 15) << 8) + p[2] - 4;
      while (i + 5 <= end) {
        if (p[i] === 0x1b || p[i] === 0x24) {
          hevc = p[i] === 0x24;
          pid = ((p[i + 1] & 31) << 8) | p[i + 2];
        }
        i += 5 + ((p[i + 3] & 15) << 8) + p[i + 4];
      }
    }
    if (id !== pid) {
      output.push(packet);
      continue;
    }
    if (packet[1] & 0x40) {
      current = { pieces: [], output: [] };
      pes.push(current);
      output.push(current);
    }
    if (current && packet[3] & 0x10) current.pieces.push(payload);
  }
  if (!pes.length) throw new Error('No video fixture PES');
  let cc = 0;
  const packetize = (data, clock) => {
    const result = [];
    for (let at = 0; at < data.length; ) {
      const first = at === 0,
        size = Math.min(first ? 176 : 184, data.length - at);
      const packet = Buffer.alloc(188, 255),
        adapted = first || size < 184;
      packet.set([
        0x47,
        (pid >> 8) | (first ? 0x40 : 0),
        pid & 255,
        (adapted ? 0x30 : 0x10) | (cc++ & 15),
      ]);
      let offset = 4;
      if (adapted) {
        const length = 183 - size;
        packet[4] = length;
        offset = 5 + length;
        if (length) packet[5] = first ? 0x10 : 0;
        if (first) {
          const base = Math.round(clock) % 2 ** 33;
          packet[6] = Math.floor(base / 2 ** 25);
          packet[7] = Math.floor(base / 2 ** 17) & 255;
          packet[8] = Math.floor(base / 2 ** 9) & 255;
          packet[9] = Math.floor(base / 2) & 255;
          packet[10] = ((base & 1) << 7) | 0x7e;
          packet[11] = 0;
        }
      }
      packet.set(data.subarray(at, at + size), offset);
      at += size;
      result.push(packet);
    }
    return result;
  };
  const parsed = pes.map((p) => {
    const bytes = Buffer.concat(p.pieces),
      head = bytes.subarray(0, 9 + bytes[8]);
    const length = bytes.readUInt16BE(4);
    const body = bytes.subarray(
      head.length,
      length ? length + 6 : bytes.length,
    );
    const clock = pts(head, head[7] >> 6 === 3 ? 14 : 9);
    return {
      slot: p,
      head: Buffer.from(head),
      body: noAud ? removeAud(body, hevc) : body,
      clock,
    };
  });
  const groupSize = mode.startsWith('bundle') ? Number(mode.slice(6) || 2) : 1;
  for (let i = 0; i < parsed.length; i += groupSize) {
    const p = parsed[i];
    p.head[4] = p.head[5] = 0;
    if (mode.startsWith('bundle')) {
      p.slot.output.push(
        ...packetize(
          Buffer.concat([
            p.head,
            ...parsed.slice(i, i + groupSize).map((p) => p.body),
          ]),
          p.clock,
        ),
      );
    } else {
      const cut = Math.min(13, p.body.length);
      p.slot.output.push(
        ...packetize(Buffer.concat([p.head, p.body.subarray(0, cut)]), p.clock),
      );
      p.slot.output.push(
        ...packetize(
          Buffer.concat([
            Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0, 0]),
            p.body.subarray(cut),
          ]),
          p.clock,
        ),
      );
    }
  }
  return Buffer.concat(
    output.flatMap((p) =>
      Buffer.isBuffer(p) || p instanceof Uint8Array ? [p] : p.output,
    ),
  );
}
