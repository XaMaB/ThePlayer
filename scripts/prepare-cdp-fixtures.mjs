import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const result = await build({
  entryPoints: [new URL('../src/engines/hls/mp4.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
});
const { box, boxes, concat, fragment } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(result.outputFiles[0].text).toString('base64')
);
const child = (data, name) => boxes(data).find((b) => b.type === name).body;
const put = (data, at, value) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(
    at,
    value,
  );
const utf8 = (text) => new TextEncoder().encode(text);
const original = new Uint8Array(
    await readFile(path.join(root, 'fmp4/init.mp4')),
  ),
  moov = child(original, 'moov');
const originalTrack = child(moov, 'trak'),
  mdia = child(originalTrack, 'mdia');
const tkhd = child(originalTrack, 'tkhd').slice();
put(tkhd, 12, 99);
put(tkhd, tkhd.length - 8, 0);
put(tkhd, tkhd.length - 4, 0);
const mdhd = child(mdia, 'mdhd').slice();
put(mdhd, 12, 90000);
const hdlr = child(mdia, 'hdlr').slice();
hdlr.set(utf8('clcp'), 8);
const minf = child(mdia, 'minf');
const stbl = box(
  'stbl',
  ...boxes(child(minf, 'stbl')).map((b) =>
    b.type === 'stsd'
      ? box(
          'stsd',
          Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1),
          box('c708', Uint8Array.of(0, 0, 0, 0, 0, 0, 0, 1)),
        )
      : box(b.type, b.body),
  ),
);
const trak = box(
  'trak',
  box('tkhd', tkhd),
  box(
    'mdia',
    box('mdhd', mdhd),
    box('hdlr', hdlr),
    box(
      'minf',
      box('nmhd', new Uint8Array(4)),
      box('dinf', child(minf, 'dinf')),
      stbl,
    ),
  ),
);
const trex = new Uint8Array(24);
put(trex, 4, 99);
put(trex, 8, 1);
put(trex, 12, 3600);
const init = concat(
  ...boxes(original).map((b) =>
    b.type === 'moov'
      ? box(
          'moov',
          ...boxes(moov).map((b) =>
            b.type === 'mvex'
              ? box('mvex', b.body, box('trex', trex))
              : box(b.type, b.body),
          ),
          trak,
        )
      : box(b.type, b.body),
  ),
);
const dir = path.join(root, 'cea708-cdp');
await mkdir(dir, { recursive: true });
await writeFile(path.join(dir, 'init.mp4'), init);
const playlist = await readFile(path.join(root, 'fmp4/index.m3u8'), 'utf8');
await writeFile(path.join(dir, 'index.m3u8'), playlist);
const define = (left) => [0x98, 0x38, 0xd0, left, 0x60, 11, 9];
const blocks = [
  [
    1,
    [0x8f, ...define(20), 0x97, 0xc0, 0, 0x0c, 0, ...utf8('Left aligned'), 3],
  ],
  [2, [0x8f, ...define(70), 0x18, 4, 0x16, 0x18, 0x4e, 0x2d, 0x18, 0xac, 0, 3]],
];
let sequence = 0,
  cdpSequence = 0;
const packet = (index) => {
  const block = blocks[index],
    pairs = [];
  if (block) {
    const [service, commands] = block;
    const data = [(service << 5) | commands.length, ...commands];
    if (data.length % 2 === 0) data.push(0);
    pairs.push(0xff, (sequence++ % 4 << 6) | ((data.length + 1) / 2), data[0]);
    for (let i = 1; i < data.length; i += 2)
      pairs.push(0xfe, data[i], data[i + 1]);
  }
  while (pairs.length < 72) pairs.push(0xfa, 0, 0);
  const count = cdpSequence++ % 65536;
  const data = Uint8Array.from([
    0x96,
    0x69,
    0,
    0x3f,
    0x43,
    count >>> 8,
    count & 255,
    0x72,
    0xf8,
    ...pairs,
    0x74,
    count >>> 8,
    count & 255,
    0,
  ]);
  data[2] = data.length;
  data[data.length - 1] = (256 - (data.reduce((a, b) => a + b, 0) % 256)) % 256;
  return box('ccdp', data);
};
let start = 0,
  serial = 1;
const durations = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => +m[1]);
for (const [index, name] of playlist
  .split('\n')
  .filter((l) => l.endsWith('.m4s'))
  .entries()) {
  const original = await readFile(path.join(root, 'fmp4', name));
  const count = Math.round(durations[index] * 25);
  const caption = fragment(
    { id: 99, kind: 'audio', timescale: 90000, codec: 'c708' },
    Array.from({ length: count }, (_, i) => ({
      data: packet(i),
      duration: 3600,
      cts: 0,
      key: true,
    })),
    Math.round(start * 90000),
    serial++,
  );
  await writeFile(path.join(dir, name), concat(original, caption));
  start += durations[index];
}
const master = (
  await readFile(path.join(root, 'cea708-mp4.m3u8'), 'utf8')
).replace('cea708-mp4/', 'cea708-cdp/');
await writeFile(path.join(root, 'cea708-cdp.m3u8'), master);
console.log(
  'Generated separate c708/ccdp track with per-frame CDP checksum and cadence',
);
