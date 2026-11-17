import { isId3, parseId3 } from './id3';
import { mp3Header } from './mp3';
import { concat, type Track, type Sample } from './mp4';
import type { TimedMetadata } from './metadata';
export function packedAudioKind(input: Uint8Array) {
  let at = 0;
  while (isId3(input, at)) at += parseId3(input.subarray(at)).consumed;
  return input[at] === 255 && (input[at + 1] & 0xf6) === 0xf0 ? 'aac' : 'mp3';
}
export function packedMp3(input: Uint8Array) {
  if (!isId3(input)) throw new Error('Packed MP3 requires an ID3 timestamp');
  let at = 0,
    timestamp: number | undefined,
    elapsed = 0,
    track: Track | undefined;
  const chunks: Uint8Array[] = [],
    metadata: TimedMetadata[] = [],
    samples: Sample[] = [];
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
      throw new Error('Packed MP3 requires an ID3 timestamp');
    const header = mp3Header(input, at);
    if (at + header.size > input.length)
      throw new Error('Incomplete packed MP3 frame');
    if (!track)
      track = {
        id: 2,
        kind: 'audio',
        timescale: header.rate,
        channels: header.channels,
        codec: 'mp3',
        audioObjectType: header.version === 3 ? 0x6b : 0x69,
      };
    if (track.timescale !== header.rate || track.channels !== header.channels)
      throw new Error('MP3 configuration changed within a segment');
    const frame = input.subarray(at, at + header.size);
    chunks.push(frame);
    samples.push({ data: frame, duration: header.samples, cts: 0, key: true });
    elapsed += header.samples / header.rate;
    at += header.size;
  }
  if (timestamp == null || !track)
    throw new Error('Packed MP3 contains no timestamped audio');
  return {
    data: concat(...chunks),
    samples,
    track,
    timestamp,
    metadata,
    duration: elapsed,
  };
}
