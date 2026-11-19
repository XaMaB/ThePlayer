import { readFile } from 'node:fs/promises';
import path from 'node:path';
export async function loopMedia(root, id, number) {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error('Invalid loop number');
  const original = ((number - 1) % 12) + 1;
  const data = await readFile(
    path.join(root, `segment-${id}-${String(original).padStart(5, '0')}.m4s`),
  );
  const manifest = await readFile(path.join(root, 'timeline.mpd'), 'utf8');
  const representation = new RegExp(
    `<Representation id="${id}"[\\s\\S]*?<SegmentTemplate timescale="(\\d+)"`,
  ).exec(manifest);
  const shift = BigInt(
    Math.floor((number - 1) / 12) * 24 * Number(representation[1]),
  );
  const walk = (start, end) => {
    for (let at = start; at + 8 <= end; ) {
      const size = data.readUInt32BE(at),
        type = data.toString('ascii', at + 4, at + 8);
      if (size < 8 || at + size > end)
        throw new Error('Invalid generated fragment');
      if (type === 'moof' || type === 'traf') walk(at + 8, at + size);
      if (type === 'tfdt') {
        if (data[at + 8] === 1)
          data.writeBigUInt64BE(data.readBigUInt64BE(at + 12) + shift, at + 12);
        else
          data.writeUInt32BE(
            data.readUInt32BE(at + 12) + Number(shift),
            at + 12,
          );
      }
      at += size;
    }
  };
  walk(0, data.length);
  return data;
}
