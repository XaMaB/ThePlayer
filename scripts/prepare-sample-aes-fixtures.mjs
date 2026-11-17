import { createCipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const crc = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte << 24;
    for (let i = 0; i < 8; i++)
      value = ((value << 1) ^ (value & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
  }
  return value;
};
function encryptTs(input, key, iv) {
  const cbc = (bytes) => {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
  };
  const escape = (bytes) => {
    const out = [];
    let zeros = 0;
    for (const value of bytes) {
      if (zeros >= 2 && value <= 3) {
        out.push(3);
        zeros = 0;
      }
      out.push(value);
      zeros = value === 0 ? zeros + 1 : 0;
    }
    return Buffer.from(out);
  };
  const encryptVideo = (bytes) => {
    const starts = [];
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (
        bytes[i] ||
        bytes[i + 1] ||
        !(bytes[i + 2] === 1 || (!bytes[i + 2] && bytes[i + 3] === 1))
      )
        continue;
      const head = i + (bytes[i + 2] === 1 ? 3 : 4);
      starts.push({ at: i, head });
      i = head - 1;
    }
    return Buffer.concat(
      starts.map(({ at, head }, index) => {
        let nal = Buffer.from(
          bytes.subarray(head, starts[index + 1]?.at ?? bytes.length),
        );
        if ([1, 5].includes(nal[0] & 31) && nal.length > 48) {
          const positions = [];
          for (let i = 32; i + 16 < nal.length; i += 160) positions.push(i);
          const cipher = cbc(
            Buffer.concat(positions.map((i) => nal.subarray(i, i + 16))),
          );
          positions.forEach((at, i) =>
            nal.set(cipher.subarray(i * 16, i * 16 + 16), at),
          );
          nal = escape(nal);
        }
        return Buffer.concat([bytes.subarray(at, head), nal]);
      }),
    );
  };
  const encryptAudio = (bytes) => {
    const out = Buffer.from(bytes);
    for (let at = 0; at < out.length; ) {
      if (out[at] !== 255 || (out[at + 1] & 0xf6) !== 0xf0)
        throw Error('Fixture AAC sync');
      const length =
        ((out[at + 3] & 3) << 11) | (out[at + 4] << 3) | (out[at + 5] >>> 5);
      if (!length || at + length > out.length)
        throw Error('Fixture AAC bounds');
      const start = at + (out[at + 1] & 1 ? 7 : 9) + 16;
      const end =
        start + Math.max(0, Math.floor((at + length - start) / 16)) * 16;
      if (end > start) out.set(cbc(out.subarray(start, end)), start);
      at += length;
    }
    return out;
  };
  const output = [],
    types = new Map(),
    pending = new Map(),
    slots = [];
  let pmt = -1;
  for (let at = 0; at < input.length; at += 188) {
    const packet = Buffer.from(input.subarray(at, at + 188)),
      pid = ((packet[1] & 31) << 8) | packet[2];
    if (!(packet[3] & 0x10)) {
      output.push(packet);
      continue;
    }
    const payload = packet.subarray(packet[3] & 0x20 ? 5 + packet[4] : 4);
    if (pid === 0 && packet[1] & 0x40) {
      const p = payload.subarray(payload[0] + 1);
      pmt = ((p[10] & 31) << 8) | p[11];
    }
    if (pid === pmt && packet[1] & 0x40) {
      const p = payload.subarray(payload[0] + 1),
        end = 3 + ((p[1] & 15) << 8) + p[2] - 4;
      if (end + 4 > p.length) throw Error('Fixture split PMT');
      for (
        let i = 12 + ((p[10] & 15) << 8) + p[11];
        i < end;
        i += 5 + ((p[i + 3] & 15) << 8) + p[i + 4]
      ) {
        if ([0x1b, 0x0f].includes(p[i])) {
          types.set(((p[i + 1] & 31) << 8) | p[i + 2], p[i]);
          p[i] = p[i] === 0x1b ? 0xdb : 0xcf;
        }
      }
      p.writeUInt32BE(crc(p.subarray(0, end)), end);
    }
    if (!types.has(pid)) {
      output.push(packet);
      continue;
    }
    if (packet[1] & 0x40) {
      const slot = { pid, type: types.get(pid), parts: [], packets: [] };
      pending.set(pid, slot);
      slots.push(slot);
      output.push(slot);
    }
    const slot = pending.get(pid);
    if (!slot) throw Error('Fixture missing PES start');
    slot.parts.push(payload);
  }
  const counters = new Map();
  for (const slot of slots) {
    const raw = Buffer.concat(slot.parts),
      header = Buffer.from(raw.subarray(0, 9 + raw[8]));
    const size = raw.readUInt16BE(4),
      body = raw.subarray(header.length, size ? size + 6 : raw.length);
    const encrypted =
      slot.type === 0x1b ? encryptVideo(body) : encryptAudio(body);
    const pesLength = header.length - 6 + encrypted.length;
    header.writeUInt16BE(pesLength <= 65535 ? pesLength : 0, 4);
    const data = Buffer.concat([header, encrypted]);
    for (let at = 0; at < data.length; ) {
      const size = Math.min(184, data.length - at),
        adapted = size < 184,
        cc = counters.get(slot.pid) ?? 0;
      counters.set(slot.pid, cc + 1);
      const packet = Buffer.alloc(188, 255);
      packet.set([
        0x47,
        (slot.pid >>> 8) | (at === 0 ? 0x40 : 0),
        slot.pid & 255,
        (adapted ? 0x30 : 0x10) | (cc & 15),
      ]);
      let offset = 4;
      if (adapted) {
        packet[4] = 183 - size;
        if (packet[4]) packet[5] = 0;
        offset = 5 + packet[4];
      }
      packet.set(data.subarray(at, at + size), offset);
      at += size;
      slot.packets.push(packet);
    }
  }
  return Buffer.concat(
    output.flatMap((p) => (Buffer.isBuffer(p) ? [p] : p.packets)),
  );
}
const playlist = await readFile(path.join(root, 'ts/index.m3u8'), 'utf8');
for (const mode of ['explicit', 'sequence']) {
  const dir = path.join(root, 'sample-aes-' + mode);
  await mkdir(dir, { recursive: true });
  let result = '',
    sequence = 0;
  for (const line of playlist.split('\n')) {
    if (line.endsWith('.ts')) {
      const key = Buffer.alloc(16, sequence % 2 ? 0x42 : 0x39),
        iv = Buffer.alloc(16);
      iv.writeUInt32BE(mode === 'explicit' ? sequence + 100 : sequence, 12);
      await writeFile(path.join(dir, `key${sequence % 2}.bin`), key);
      await writeFile(
        path.join(dir, line),
        encryptTs(await readFile(path.join(root, 'ts', line)), key, iv),
      );
      // KEY applies to the following segment; placing it after EXTINF is legal.
      result += `#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key${sequence % 2}.bin"${mode === 'explicit' ? ',IV=0x' + iv.toString('hex') : ''}\n`;
      sequence++;
    }
    result += line + '\n';
  }
  await writeFile(
    path.join(dir, 'index.m3u8'),
    result.replace(/#EXT-X-VERSION:\d+/, '#EXT-X-VERSION:5'),
  );
}
console.log(
  'Prepared SAMPLE-AES TS fixtures with AVC/AAC, rotating keys and explicit/sequence IVs',
);
