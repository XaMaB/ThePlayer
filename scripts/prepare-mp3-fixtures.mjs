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
const tag = (timestamp, title) => {
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(timestamp));
  const body = Buffer.concat([
    frame(
      'PRIV',
      Buffer.concat([
        Buffer.from('com.apple.streaming.transportStreamTimestamp\0'),
        time,
      ]),
    ),
    frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from(title)])),
  ]);
  return Buffer.concat([
    Buffer.from([73, 68, 51, 4, 0, 0]),
    ss(body.length),
    body,
  ]);
};
for (const [mode, rate] of [
  ['mpeg1', 44100],
  ['mpeg2', 22050],
  ['mpeg25', 11025],
  ['vbr', 44100],
  ['aes128', 44100],
  ['rollover', 44100],
]) {
  const dir = path.join(root, 'packed-mp3-' + mode);
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, 'original.mp3');
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
    '2',
    '-c:a',
    'libmp3lame',
    ...(mode === 'vbr'
      ? ['-q:a', '4']
      : ['-b:a', rate === 11025 ? '32k' : '64k']),
    '-write_xing',
    '0',
    '-id3v2_version',
    '0',
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
          'packet=pos,size,duration_time',
          '-of',
          'json',
          source,
        ],
        { encoding: 'utf8' },
      ),
    );
  const groups = [];
  let current = [],
    duration = 0;
  for (const packet of probe.packets) {
    current.push(packet);
    duration += Number(packet.duration_time);
    if (duration >= 2) {
      groups.push(current);
      current = [];
      duration = 0;
    }
  }
  if (current.length) groups.push(current);
  const sampleCount = rate === 44100 ? 1152 : 576,
    key = Buffer.alloc(16, 0x48);
  await writeFile(path.join(dir, 'key.bin'), key);
  let playlist =
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXT-X-PLAYLIST-TYPE:VOD\n',
    total = 0;
  if (mode === 'aes128')
    playlist += '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n';
  for (const [index, packets] of groups.entries()) {
    const timestamp =
        (Math.round((total * 90000) / rate) +
          (mode === 'rollover' ? 2 ** 33 - 90000 : 0)) %
        2 ** 33,
      header = tag(timestamp, 'MP3 ' + index);
    let data = Buffer.concat([
      header,
      ...packets.map((p) =>
        bytes.subarray(Number(p.pos), Number(p.pos) + Number(p.size)),
      ),
    ]);
    if (mode === 'aes128') {
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(index, 12);
      const cipher = createCipheriv('aes-128-cbc', key, iv);
      data = Buffer.concat([cipher.update(data), cipher.final()]);
    }
    const name = `segment${index}.mp3`;
    await writeFile(path.join(dir, name), data);
    playlist += `#EXTINF:${((packets.length * sampleCount) / rate).toFixed(9)},\n${name}\n`;
    total += packets.length * sampleCount;
  }
  await writeFile(path.join(dir, 'index.m3u8'), playlist + '#EXT-X-ENDLIST\n');
  await writeFile(
    path.join(dir, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,CODECS="mp4a.6B"\nindex.m3u8\n',
  );
}
console.log(
  'Prepared packed MPEG-1/2/2.5 Layer III, CBR/VBR, AES-128 and rollover fixtures',
);
