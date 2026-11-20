import { boxes, box, concat, videoSampleEntryBoxes } from './mp4';

/** Remove only the validated QuickTime visual terminator before MSE ingestion.
 * Chromium rejects it even though QuickTime permits it. Rebuild enclosing sizes;
 * sample payloads, codec configuration, encryption and fragment offsets are unchanged.
 */
export function normalizeVideoSampleEntries(init: Uint8Array): Uint8Array {
  const rewrite = (data: Uint8Array, level: number): Uint8Array => {
    let changed = false;
    const parts = boxes(data).map((entry) => {
      let body = entry.body;
      const container = ['moov', 'trak', 'mdia', 'minf', 'stbl'][level];
      if (entry.type === container) body = rewrite(body, level + 1);
      else if (level === 5 && entry.type === 'stsd') {
        const entries = rewrite(body.subarray(8), 6);
        if (
          entries.buffer !== body.buffer ||
          entries.byteOffset !== body.byteOffset + 8
        )
          body = concat(body.subarray(0, 8), entries);
      } else if (
        level === 6 &&
        ['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'encv'].includes(entry.type)
      ) {
        const extensions = videoSampleEntryBoxes(body);
        const end = extensions.length
          ? extensions.at(-1)!.at + extensions.at(-1)!.size
          : 0;
        if (body.length - 78 - end === 4)
          body = body.subarray(0, body.length - 4);
      }
      if (body !== entry.body) {
        changed = true;
        return box(entry.type, body);
      }
      return data.subarray(entry.at, entry.at + entry.size);
    });
    return changed ? concat(...parts) : data;
  };
  return rewrite(init, 0);
}
