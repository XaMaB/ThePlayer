import { readFile } from 'node:fs/promises';
import path from 'node:path';
/** Build an independent two-level index over the original encoded test media. */
export async function indexedMedia(root, id) {
  const init = await readFile(path.join(root, `init-${id}.mp4`));
  const segments = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      readFile(
        path.join(root, `segment-${id}-${String(i + 1).padStart(5, '0')}.m4s`),
      ),
    ),
  );
  const entries = segments.map((data) => {
    let at = 0;
    while (at < data.length) {
      const size = data.readUInt32BE(at);
      if (data.toString('ascii', at + 4, at + 8) === 'sidx') {
        if (data[at + 8] !== 1)
          throw new Error('Expected version 1 fixture SIDX');
        return {
          size: data.length,
          scale: data.readUInt32BE(at + 16),
          time: data.readBigUInt64BE(at + 20),
          duration: data.readUInt32BE(at + 44),
        };
      }
      at += size;
    }
    throw new Error('Missing fixture SIDX');
  });
  const index = (refs) => {
    const b = Buffer.alloc(40 + 12 * refs.length);
    b.writeUInt32BE(b.length);
    b.write('sidx', 4);
    b[8] = 1;
    b.writeUInt32BE(1, 12);
    b.writeUInt32BE(entries[0].scale, 16);
    b.writeBigUInt64BE(entries[0].time, 20);
    b.writeUInt16BE(refs.length, 38);
    refs.forEach((r, i) => {
      b.writeUInt32BE(r.size, 40 + i * 12);
      b.writeUInt32BE(r.duration, 44 + i * 12);
      b.writeUInt32BE(0x90000000, 48 + i * 12);
    });
    return b;
  };
  const child = index(entries);
  const parent = index([
    {
      size: 0x80000000 + child.length,
      duration: entries.reduce((n, e) => n + e.duration, 0),
    },
  ]);
  return {
    data: Buffer.concat([init, parent, child, ...segments]),
    initEnd: init.length - 1,
    indexStart: init.length,
    indexEnd: init.length + parent.length - 1,
  };
}
