import { createCipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const original = await readFile(path.join(root, 'fmp4/index.m3u8'), 'utf8');
const files = original.split('\n').filter((line) => line.endsWith('.m4s'));
const durations = [...original.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => +m[1]);
const iv = (n) => {
  const out = Buffer.alloc(16);
  out.writeUInt32BE(n, 12);
  return out;
};
const encrypt = (data, key, iv, gcm) => {
  const cipher = createCipheriv(gcm ? 'aes-256-gcm' : 'aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return gcm ? Buffer.concat([iv, encrypted, cipher.getAuthTag()]) : encrypted;
};
for (const mode of ['map-rotation', 'gcm', 'gcm-tampered']) {
  const gcm = mode.startsWith('gcm'),
    dir = path.join(root, 'crypto-' + mode);
  await mkdir(dir, { recursive: true });
  const keys = Array.from({ length: 4 }, (_, i) =>
    Buffer.alloc(gcm ? 32 : 16, 0x21 + i),
  );
  for (let i = 0; i < keys.length; i++)
    await writeFile(path.join(dir, 'key' + i + '.bin'), keys[i]);
  const method = gcm ? 'AES-256-GCM' : 'AES-128';
  const keyTag = (i, n) =>
    `#EXT-X-KEY:METHOD=${method},URI="key${i}.bin"${gcm ? '' : ',IV=0x' + iv(n).toString('hex')}\n`;
  let media = `#EXTM3U\n#EXT-X-VERSION:13\n#EXT-X-TARGETDURATION:2\n${keyTag(0, 77)}#EXT-X-MAP:URI="init.mp4"\n`;
  await writeFile(
    path.join(dir, 'init.mp4'),
    encrypt(
      await readFile(path.join(root, 'fmp4/init.mp4')),
      keys[0],
      iv(77),
      gcm,
    ),
  );
  for (const [index, name] of files.entries()) {
    const clear = !gcm && index % 3 === 2,
      keyIndex = (index % 3) + 1;
    media += clear ? '#EXT-X-KEY:METHOD=NONE\n' : keyTag(keyIndex, index + 100);
    if (!gcm && !clear)
      media += `#EXT-X-KEY:METHOD=AES-128,URI="key${keyIndex}.bin",KEYFORMAT="example.alternative"\n`;
    media += `#EXTINF:${durations[index]},\n${name}\n`;
    const raw = await readFile(path.join(root, 'fmp4', name));
    const encoded = clear
      ? raw
      : encrypt(raw, keys[keyIndex], iv(index + 100), gcm);
    if (mode === 'gcm-tampered' && index === 0)
      encoded[encoded.length - 1] ^= 1;
    await writeFile(path.join(dir, name), encoded);
  }
  media += '#EXT-X-ENDLIST\n';
  await writeFile(path.join(dir, 'index.m3u8'), media);
  const session = (i) =>
    `#EXT-X-SESSION-KEY:METHOD=${method},URI="crypto-${mode}/key${i}.bin"${gcm ? '' : ',IV=0x' + iv(i ? 100 : 77).toString('hex')}\n`;
  await writeFile(
    path.join(root, 'crypto-' + mode + '.m3u8'),
    `#EXTM3U\n${session(0)}${session(1)}#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2"\ncrypto-${mode}/index.m3u8\n`,
  );
}
console.log(
  'Generated independent map/media key rotation, clear transitions, session keys and authenticated GCM fixtures',
);
