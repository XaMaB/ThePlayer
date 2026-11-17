import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
async function module(name) {
  const r = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(r.outputFiles[0].text).toString('base64')
  );
}
const { box, concat, u32 } = await module('mp4'),
  { demux } = await module('transport-stream'),
  { psiCrc } = await module('psi'),
  { fragmentMetadata, fragmentSamples } = await module('fragment-samples');
const ss = (n) =>
  Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const tag = (text) => {
  const body = Buffer.concat([
    Buffer.from('TIT2'),
    ss(Buffer.byteLength(text) + 1),
    Buffer.from([0, 0, 3]),
    Buffer.from(text),
  ]);
  return Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([4, 0, 0]),
    ss(body.length),
    body,
  ]);
};
const pts = (n) =>
  Buffer.from([
    0x21 | ((Math.floor(n / 2 ** 30) & 7) << 1),
    Math.floor(n / 2 ** 22) & 255,
    ((Math.floor(n / 2 ** 15) & 127) << 1) | 1,
    Math.floor(n / 128) & 255,
    ((n & 127) << 1) | 1,
  ]);
function tsMetadata(input, body, time) {
  const output = Buffer.from(input);
  let pmt = -1;
  for (let at = 0; at < output.length; at += 188) {
    const p = output.subarray(at, at + 188),
      pid = ((p[1] & 31) << 8) | p[2];
    if (!(p[3] & 0x10)) continue;
    const offset = p[3] & 0x20 ? 5 + p[4] : 4,
      payload = p.subarray(offset);
    if (pid === 0 && p[1] & 0x40) {
      const table = payload.subarray(1 + payload[0]);
      pmt = ((table[10] & 31) << 8) | table[11];
    }
    if (pid !== pmt || !(p[1] & 0x40)) continue;
    const start = 1 + payload[0],
      old = payload.subarray(start),
      length = 3 + ((old[1] & 15) << 8) + old[2];
    const table = Buffer.concat([
      old.subarray(0, length - 4),
      Buffer.from([0x15, 0xe1, 0xff, 0xf0, 0]),
      Buffer.alloc(4),
    ]);
    table[1] = 0xb0 | ((table.length - 3) >>> 8);
    table[2] = (table.length - 3) & 255;
    table.writeUInt32BE(psiCrc(table.subarray(0, -4)), table.length - 4);
    if (start + table.length > payload.length)
      throw Error('Fixture PMT capacity');
    payload.fill(255, start);
    payload.set(table, start);
  }
  const length = 8 + body.length,
    pes = Buffer.concat([
      Buffer.from([0, 0, 1, 0xbd, length >>> 8, length & 255, 0x80, 0x80, 5]),
      pts(time),
      body,
    ]),
    packets = [];
  for (let at = 0, cc = 0; at < pes.length; ) {
    const size = Math.min(184, pes.length - at),
      p = Buffer.alloc(188, 255),
      adapted = size < 184;
    p.set([
      0x47,
      0x01 | (at === 0 ? 0x40 : 0),
      0xff,
      (adapted ? 0x30 : 0x10) | (cc++ & 15),
    ]);
    let offset = 4;
    if (adapted) {
      p[4] = 183 - size;
      if (p[4]) p[5] = 0;
      offset = 5 + p[4];
    }
    p.set(pes.subarray(at, at + size), offset);
    at += size;
    packets.push(p);
  }
  return Buffer.concat([output, ...packets]);
}
for (const mode of [
  'ts',
  'ts-malformed',
  'emsg',
  'emsg-v0',
  'emsg-malformed',
]) {
  const dir = path.join(root, 'metadata-' + mode),
    source = mode.startsWith('ts') ? 'ts' : 'fmp4';
  await mkdir(dir, { recursive: true });
  const playlist = await readFile(
    path.join(root, source, 'index.m3u8'),
    'utf8',
  );
  await writeFile(path.join(dir, 'index.m3u8'), playlist);
  let init, meta;
  if (source === 'fmp4') {
    init = await readFile(path.join(root, source, 'init.mp4'));
    meta = fragmentMetadata(init);
    await writeFile(path.join(dir, 'init.mp4'), init);
  }
  let sequence = 0;
  for (const name of playlist
    .split('\n')
    .filter((l) => /\.(ts|m4s)$/.test(l))) {
    const input = await readFile(path.join(root, source, name)),
      title = 'Metadata ' + sequence,
      body = tag(title);
    let output;
    if (source === 'ts') {
      const first = demux(input).find((p) => p.type === 0x1b && p.pts != null);
      output = tsMetadata(
        input,
        mode.endsWith('malformed') ? body.subarray(0, -1) : body,
        first.pts,
      );
    } else {
      const time = Math.min(...fragmentSamples(input, meta).map((s) => s.time)),
        stamp = Buffer.alloc(8);
      stamp.writeBigUInt64BE(BigInt(Math.round(time * 90000)));
      let emsg;
      if (mode === 'emsg-v0')
        emsg = box(
          'emsg',
          new Uint8Array(4),
          Buffer.from('urn:theplayer:test\0value\0'),
          u32(90000),
          u32(45000),
          u32(90000),
          u32(sequence),
          Buffer.from(title),
        );
      else
        emsg = box(
          'emsg',
          Uint8Array.of(1, 0, 0, 0),
          u32(mode.endsWith('malformed') ? 0 : 90000),
          stamp,
          u32(0xffffffff),
          u32(sequence),
          Buffer.from('https://aomedia.org/emsg/ID3\0\0'),
          body,
        );
      output = concat(emsg, input);
    }
    await writeFile(path.join(dir, name), output);
    sequence++;
  }
}
console.log(
  'Prepared timed ID3 TS and emsg v0/v1, with malformed metadata recovery cases',
);
