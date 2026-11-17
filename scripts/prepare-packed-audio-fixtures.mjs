import { build } from 'esbuild';
import { createCipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const built = await build({
  entryPoints: [
    new URL('../src/engines/hls/transport-stream.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const { demux } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(built.outputFiles[0].text).toString('base64')
);
const ss = (n) =>
  Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const frame = (id, body, version) =>
  Buffer.concat([
    Buffer.from(id),
    version === 3 ? u32(body.length) : ss(body.length),
    Buffer.alloc(2),
    body,
  ]);
const tag = (frames, version) => {
  const body = Buffer.concat(frames);
  return Buffer.concat([
    Buffer.from([73, 68, 51, version, 0, 0]),
    ss(body.length),
    body,
  ]);
};
const text = (value, version) =>
  frame(
    'TIT2',
    Buffer.concat([Buffer.from([version === 3 ? 0 : 3]), Buffer.from(value)]),
    version,
  );
const encrypt = (bytes, key, iv, padding) => {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(padding);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};
const original = await readFile(path.join(root, 'audio-64/index.m3u8'), 'utf8'),
  files = original.split('\n').filter((l) => l.endsWith('.ts'));
for (const mode of ['clear', 'v3', 'rollover', 'aes128', 'sample-aes']) {
  const dir = path.join(root, 'packed-aac-' + mode);
  await mkdir(dir, { recursive: true });
  const version = mode === 'v3' ? 3 : 4,
    key = Buffer.alloc(16, 0x46);
  await writeFile(path.join(dir, 'key.bin'), key);
  const method =
    mode === 'aes128'
      ? 'AES-128'
      : mode === 'sample-aes'
        ? 'SAMPLE-AES'
        : undefined;
  let playlist = original
    .replaceAll('.ts', '.aac')
    .replace(/#EXT-X-VERSION:\d+/, '#EXT-X-VERSION:5');
  if (method)
    playlist = playlist.replace(
      '#EXT-X-TARGETDURATION',
      `#EXT-X-KEY:METHOD=${method},URI="key.bin"\n#EXT-X-TARGETDURATION`,
    );
  await writeFile(path.join(dir, 'index.m3u8'), playlist);
  let epoch;
  for (const [sequence, name] of files.entries()) {
    const packets = demux(
      await readFile(path.join(root, 'audio-64', name)),
    ).filter((p) => p.type === 0x0f);
    epoch ??= packets[0].pts;
    const time =
        (packets[0].pts + (mode === 'rollover' ? 2 ** 33 - 90000 - epoch : 0)) %
        2 ** 33,
      stamp = Buffer.alloc(8);
    stamp.writeBigUInt64BE(BigInt(Math.round(time)));
    const leading = tag(
      [
        frame(
          'PRIV',
          Buffer.concat([
            Buffer.from('com.apple.streaming.transportStreamTimestamp\0'),
            stamp,
          ]),
          version,
        ),
        text('Segment ' + sequence, version),
      ],
      version,
    );
    const audio = Buffer.concat(packets.map((p) => p.data)),
      chunks = [leading],
      iv = Buffer.alloc(16);
    iv.writeUInt32BE(sequence, 12);
    let sample = 0;
    for (let at = 0; at < audio.length; ) {
      const length =
          ((audio[at + 3] & 3) << 11) |
          (audio[at + 4] << 3) |
          (audio[at + 5] >>> 5),
        bytes = Buffer.from(audio.subarray(at, at + length));
      if (!length || at + length > audio.length)
        throw Error('Invalid fixture AAC');
      if (mode === 'sample-aes') {
        const start = (bytes[1] & 1 ? 7 : 9) + 16,
          end = start + Math.max(0, Math.floor((length - start) / 16)) * 16;
        if (end > start)
          bytes.set(encrypt(bytes.subarray(start, end), key, iv, false), start);
      }
      chunks.push(bytes);
      at += length;
      if (sample++ === 0)
        chunks.push(tag([text('Inside ' + sequence, version)], version));
    }
    const data = Buffer.concat(chunks);
    await writeFile(
      path.join(dir, name.replace('.ts', '.aac')),
      mode === 'aes128' ? encrypt(data, key, iv, true) : data,
    );
  }
}
console.log(
  'Prepared packed AAC: ID3 v2.3/v2.4, rollover, interleaved metadata, AES-128 and SAMPLE-AES',
);
