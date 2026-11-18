import { createCipheriv } from 'node:crypto';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const bundled = await build({
  entryPoints: [new URL('../src/engines/hls/mp4.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { boxes, box, concat, fragment } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
const child = (d, type) => boxes(d).find((b) => b.type === type).body;
const u32 = (d, at, value) =>
  new DataView(d.buffer, d.byteOffset, d.byteLength).setUint32(at, value);
const utf8 = (text) => new TextEncoder().encode(text);
const original = new Uint8Array(
  await readFile(path.join(root, 'fmp4/init.mp4')),
);
const moov = child(original, 'moov'),
  originalTrack = child(moov, 'trak');
for (const format of ['stpp', 'wvtt']) {
  const dir = path.join(root, format);
  await mkdir(dir, { recursive: true });
  const tkhd = child(originalTrack, 'tkhd').slice();
  u32(tkhd, 12, 99);
  u32(tkhd, tkhd.length - 8, 0);
  u32(tkhd, tkhd.length - 4, 0);
  const originalMdia = child(originalTrack, 'mdia');
  const mdhd = child(originalMdia, 'mdhd').slice();
  u32(mdhd, 12, 1000);
  const hdlr = child(originalMdia, 'hdlr').slice();
  hdlr.set(utf8(format === 'stpp' ? 'subt' : 'text'), 8);
  const entry = box(
    format,
    Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]),
    format === 'stpp'
      ? utf8('http://www.w3.org/ns/ttml\0\0\0')
      : box('vttC', utf8('WEBVTT')),
  );
  const originalMinf = child(originalMdia, 'minf');
  const stbl = box(
    'stbl',
    ...boxes(child(originalMinf, 'stbl')).map((b) =>
      b.type === 'stsd'
        ? box('stsd', Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]), entry)
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
        box('dinf', child(originalMinf, 'dinf')),
        stbl,
      ),
    ),
  );
  const trex = child(child(moov, 'mvex'), 'trex').slice();
  u32(trex, 4, 99);
  await writeFile(
    path.join(dir, 'init.mp4'),
    concat(
      box('ftyp', utf8('iso6'), new Uint8Array(4), utf8('iso6mp41')),
      box(
        'moov',
        box('mvhd', child(moov, 'mvhd')),
        trak,
        box('mvex', box('trex', trex)),
      ),
    ),
  );
  let playlist =
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n';
  for (let i = 0; i < 9; i++) {
    const start = i * 2;
    const xml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:profile="http://www.w3.org/ns/ttml/profile/imsc1/text"><head><styling><style xml:id="base" tts:color="white" tts:fontFamily="proportionalSansSerif" tts:textAlign="left"/></styling><layout><region xml:id="lower" tts:origin="10% 60%" tts:extent="80% 30%" tts:displayAlign="after"/></layout></head><body><div><p region="lower" style="base" begin="${start}s" end="${start + 1.9}s">TTML ${i} <span tts:color="yellow"><set begin="1s" dur="0.5s" tts:color="lime"/>left aligned</span><br/><span begin="0.5s" end="1.5s" tts:fontStyle="italic">Timed span</span><span tts:ruby="container"><span tts:ruby="base">Ruby</span><span tts:ruby="text">guide</span></span></p></div></body></tt>`;
    const data =
      format === 'stpp'
        ? utf8(xml)
        : box(
            'vttc',
            box('payl', utf8(`MP4 WebVTT ${i}`)),
            box('sttg', utf8('line:80% position:10% align:start size:80%')),
          );
    const file = `segment${i}.m4s`;
    await writeFile(
      path.join(dir, file),
      fragment(
        { id: 99, kind: 'audio', timescale: 1000, codec: format },
        [{ data, duration: 2000, cts: 0, key: true }],
        start * 1000,
        i + 1,
      ),
    );
    playlist += '#EXTINF:2,\n' + file + '\n';
  }
  await writeFile(path.join(dir, 'index.m3u8'), playlist + '#EXT-X-ENDLIST\n');
}
const encrypted = path.join(root, 'stpp-encrypted');
await mkdir(encrypted, { recursive: true });
const key = Buffer.alloc(16, 0x71),
  iv = Buffer.alloc(16, 0x28);
await writeFile(path.join(encrypted, 'key.bin'), key);
for (const file of [
  'init.mp4',
  ...Array.from({ length: 9 }, (_, i) => `segment${i}.m4s`),
]) {
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  await writeFile(
    path.join(encrypted, file),
    Buffer.concat([
      cipher.update(await readFile(path.join(root, 'stpp', file))),
      cipher.final(),
    ]),
  );
}
await writeFile(
  path.join(encrypted, 'index.m3u8'),
  (await readFile(path.join(root, 'stpp/index.m3u8'), 'utf8')).replace(
    '#EXT-X-MAP',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x' +
      iv.toString('hex') +
      '\n#EXT-X-MAP',
  ),
);
await writeFile(
  path.join(root, 'text-mp4.m3u8'),
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="IMSC",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="stpp/index.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="MP4 WebVTT",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="wvtt/index.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Encrypted IMSC",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=NO,URI="stpp-encrypted/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.42c00c,mp4a.40.2,stpp.ttml.im1t,wvtt",SUBTITLES="s"\nfmp4/index.m3u8\n',
);
console.log('Generated original stpp/IMSC and wvtt fixtures');
