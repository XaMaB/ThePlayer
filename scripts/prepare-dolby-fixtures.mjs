import { execFileSync } from 'node:child_process';
import { createCipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const ss = (n) =>
  Buffer.from([(n >>> 21) & 127, (n >>> 14) & 127, (n >>> 7) & 127, n & 127]);
const frame = (id, body) =>
  Buffer.concat([Buffer.from(id), ss(body.length), Buffer.alloc(2), body]);
const tag = (timestamp, title, setup) => {
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(timestamp));
  const frames = [
    frame(
      'PRIV',
      Buffer.concat([
        Buffer.from('com.apple.streaming.transportStreamTimestamp\0'),
        time,
      ]),
    ),
    frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(title)])),
  ];
  if (setup)
    frames.push(
      frame(
        'PRIV',
        Buffer.concat([
          Buffer.from('com.apple.streaming.audioDescription\0zac3'),
          Buffer.from([0, 0, 1, 10]),
          setup,
        ]),
      ),
    );
  const body = Buffer.concat(frames);
  return Buffer.concat([
    Buffer.from([73, 68, 51, 4, 0, 0]),
    ss(body.length),
    body,
  ]);
};
const encrypt = (data, key, iv, pad) => {
  const c = createCipheriv('aes-128-cbc', key, iv);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
};
for (const [mode, rate, channels] of [
  ['48', 48000, 2],
  ['44', 44100, 2],
  ['32', 32000, 2],
  ['surround', 48000, 6],
  ['aes128', 48000, 2],
  ['sample-aes', 48000, 2],
]) {
  const dir = path.join(root, 'packed-ac3-' + mode);
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, 'original.ac3');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=${rate}`,
    '-t',
    '14',
    '-ac',
    String(channels),
    '-c:a',
    'ac3',
    '-b:a',
    '384k',
    '-f',
    'ac3',
    '-y',
    source,
  ]);
  const bytes = await readFile(source),
    probe = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_packets',
          '-show_entries',
          'packet=pos,size',
          '-of',
          'json',
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
  const perSegment = Math.ceil((rate * 2) / 1536),
    key = Buffer.alloc(16, 0x51);
  await writeFile(path.join(dir, 'key.bin'), key);
  let playlist =
    '#EXTM3U\n#EXT-X-VERSION:5\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n';
  if (['aes128', 'sample-aes'].includes(mode))
    playlist += `#EXT-X-KEY:METHOD=${mode === 'aes128' ? 'AES-128' : 'SAMPLE-AES'},URI="key.bin"\n`;
  for (
    let at = 0, index = 0;
    at < probe.packets.length;
    at += perSegment, index++
  ) {
    const packets = probe.packets.slice(at, at + perSegment),
      iv = Buffer.alloc(16);
    iv.writeUInt32BE(index, 12);
    const frames = packets.map((p) => {
      const b = Buffer.from(
        bytes.subarray(Number(p.pos), Number(p.pos) + Number(p.size)),
      );
      if (mode === 'sample-aes') {
        const end = 16 + Math.floor((b.length - 16) / 16) * 16;
        b.set(encrypt(b.subarray(16, end), key, iv, false), 16);
      }
      return b;
    });
    let data = Buffer.concat([
      tag(
        Math.round((at * 1536 * 90000) / rate),
        'AC-3 ' + index,
        mode === 'sample-aes' ? bytes.subarray(0, 10) : undefined,
      ),
      ...frames,
    ]);
    if (mode === 'aes128') data = encrypt(data, key, iv, true);
    const name = `segment${index}.ac3`;
    await writeFile(path.join(dir, name), data);
    playlist += `#EXTINF:${((packets.length * 1536) / rate).toFixed(9)},\n${name}\n`;
  }
  await writeFile(path.join(dir, 'index.m3u8'), playlist + '#EXT-X-ENDLIST\n');
  await writeFile(
    path.join(dir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="ac-3"\nindex.m3u8\n',
  );
}
for (const [mode, codec, container] of [
  ['ts-ac3', 'ac3', 'mpegts'],
  ['fmp4-ac3', 'ac3', 'fmp4'],
  ['fmp4-eac3', 'eac3', 'fmp4'],
]) {
  const dir = path.join(root, mode);
  await mkdir(dir, { recursive: true });
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '14',
    '-ac',
    '2',
    '-c:a',
    codec,
    '-b:a',
    '384k',
    '-hls_time',
    '2',
    '-hls_segment_type',
    container,
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    path.join(dir, container === 'mpegts' ? 'segment%d.ts' : 'segment%d.m4s'),
    '-y',
    path.join(dir, 'index.m3u8'),
  ]);
  await writeFile(
    path.join(dir, 'master.m3u8'),
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="${codec === 'ac3' ? 'ac-3' : 'ec-3'}"\nindex.m3u8\n`,
  );
}
console.log(
  'Prepared packed/TS/fMP4 AC-3 and fMP4 E-AC-3 with clear/AES-128/SAMPLE-AES cases',
);
