import { boxes } from './mp4';
import {
  fragmentMetadata,
  fragmentSamples,
  type FragmentTrack,
} from './fragment-samples';
export const captionMetadata = fragmentMetadata;
export interface CaptionPacket {
  time: number;
  first: number;
  second: number;
  field?: 1 | 2;
}
export function extract608(
  data: Uint8Array,
  metadata: FragmentTrack[],
  resourceOffset = 0,
): CaptionPacket[] {
  if (!metadata.some((t) => t.format === 'c608')) return [];
  if (metadata.filter((t) => t.format === 'c608').length > 1)
    throw new Error('Multiple c608 tracks are not yet supported');
  const samples = fragmentSamples(data, metadata, resourceOffset);
  const pending = samples.filter((s) => s.track.format === 'c608');
  const frameDuration =
    samples.find((s) => s.track.video && s.duration > 0)?.duration ?? 0;
  const packets: CaptionPacket[] = [];
  for (const sample of pending) {
    let index = 0;
    for (const atom of boxes(sample.data)) {
      if (!['cdat', 'cdt2'].includes(atom.type)) continue;
      index = 0;
      if (atom.body.length % 2) throw new Error('Odd cdat byte count');
      if (atom.body.length > 2 && !(frameDuration > 0 && frameDuration <= 1))
        throw new Error('Missing video cadence for cdat');
      for (let i = 0; i < atom.body.length; i += 2, index++) {
        const delta = index * frameDuration;
        if (delta >= sample.duration + 0.001)
          throw new Error('cdat pairs exceed sample duration');
        packets.push({
          time: sample.time + delta,
          first: atom.body[i],
          second: atom.body[i + 1],
          ...(atom.type === 'cdt2' ? { field: 2 as const } : {}),
        });
      }
    }
  }
  return packets.sort((a, b) => a.time - b.time);
}
