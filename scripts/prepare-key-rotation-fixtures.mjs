/** Rotate KIDs while retaining the synthetic CENC payload/key and box offsets. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dir = path.join(root, 'cenc-long-rotation');
await mkdir(dir, { recursive: true });
const original = await readFile(path.join(root, 'cenc/init.mp4'));
const oldKid = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
let playlist =
  '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="license",KEYFORMAT="org.w3.clearkey"\n';
for (let n = 0; n < 80; n++) {
  const init = Buffer.from(original),
    kid = Buffer.alloc(16);
  kid.writeUInt32BE(n + 1, 12);
  let replacements = 0;
  for (
    let offset = init.indexOf(oldKid);
    offset >= 0;
    offset = init.indexOf(oldKid, offset + 16)
  ) {
    kid.copy(init, offset);
    replacements++;
  }
  if (replacements < 3)
    throw new Error('Expected audio/video tenc and common PSSH KIDs');
  await writeFile(path.join(dir, `init${n}.mp4`), init);
  if (n) playlist += '#EXT-X-DISCONTINUITY\n';
  playlist += `#EXT-X-MAP:URI="init${n}.mp4"\n#EXTINF:2,\n../cenc/segment00.m4s\n`;
}
await writeFile(path.join(dir, 'index.m3u8'), playlist + '#EXT-X-ENDLIST\n');
console.log('Generated 80 distinct KIDs with original synthetic CENC media');
