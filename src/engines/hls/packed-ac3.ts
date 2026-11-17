import { eac3Header } from './eac3';
import { isId3, parseId3 } from './id3';
import { ac3Header } from './ac3';
import { concat } from './mp4';
import type { TimedMetadata } from './metadata';
export function packedAc3(input: Uint8Array) {
  if (!isId3(input)) throw new Error('Packed AC-3 requires an ID3 timestamp');
  let at = 0,
    timestamp: number | undefined,
    elapsed = 0,
    type: number | undefined;
  const chunks: Uint8Array[] = [],
    metadata: TimedMetadata[] = [];
  while (at < input.length) {
    if (isId3(input, at)) {
      const tag = parseId3(input.subarray(at));
      if (timestamp == null && !chunks.length) timestamp = tag.timestamp;
      if (timestamp != null)
        metadata.push({
          type: 'id3',
          time: (tag.timestamp ?? timestamp + elapsed * 90000) / 90000,
          frames: tag.frames,
        });
      at += tag.consumed;
      continue;
    }
    if (timestamp == null)
      throw new Error('Packed AC-3 requires an ID3 timestamp');
    const enhanced = input[at + 5] >>> 3 === 16;
    const frameType = enhanced ? 0x87 : 0x81;
    if (type != null && type !== frameType)
      throw new Error('Mixed AC-3/E-AC-3 packed segment');
    type = frameType;
    const header = enhanced ? eac3Header(input, at) : ac3Header(input, at);
    if (at + header.size > input.length)
      throw new Error('Incomplete packed AC-3 frame');
    chunks.push(input.subarray(at, at + header.size));
    elapsed += ('blocks' in header ? header.blocks * 256 : 1536) / header.rate;
    at += header.size;
  }
  if (timestamp == null || !chunks.length)
    throw new Error('Packed AC-3 contains no timestamped audio');
  return {
    pes: [
      { type: type!, pts: timestamp, dts: timestamp, data: concat(...chunks) },
    ],
    metadata,
  };
}
