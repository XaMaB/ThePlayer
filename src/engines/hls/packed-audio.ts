import { isId3, parseId3 } from './id3';
import { concat } from './mp4';
import { sampleRates } from './aac';
import type { TimedMetadata } from './metadata';
/** Preserve the mandatory 90 kHz ID3 anchor while removing interleaved metadata from ADTS. */
export function packedAac(input: Uint8Array) {
  if (!isId3(input))
    throw new Error('Packed audio requires a leading ID3 timestamp');
  let at = 0,
    timestamp: number | undefined,
    elapsed = 0;
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
      throw new Error('Packed audio requires a leading ID3 timestamp');
    if (
      at + 7 > input.length ||
      input[at] !== 255 ||
      (input[at + 1] & 0xf6) !== 0xf0
    )
      throw new Error('Packed audio codec is not ADTS AAC');
    const length =
        ((input[at + 3] & 3) << 11) |
        (input[at + 4] << 3) |
        (input[at + 5] >>> 5),
      header = input[at + 1] & 1 ? 7 : 9;
    const rate = sampleRates[(input[at + 2] >>> 2) & 15];
    if (
      !rate ||
      length < header ||
      at + length > input.length ||
      input[at + 6] & 3
    )
      throw new Error('Invalid packed AAC frame');
    chunks.push(input.subarray(at, at + length));
    elapsed += 1024 / rate;
    at += length;
  }
  if (timestamp == null || !chunks.length)
    throw new Error('Packed audio contains no timestamped samples');
  return {
    pes: [
      { type: 0x0f, pts: timestamp, dts: timestamp, data: concat(...chunks) },
    ],
    metadata,
  };
}
