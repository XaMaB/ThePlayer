import { boxes } from './mp4';
import { fragmentSamples, type FragmentTrack } from './fragment-samples';
import type { CcData } from './cea-sei';

const rates = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60];

/** Caption Distribution Packet framing, CTA-708 section 11.2. */
export function captionDistributionPacket(data: Uint8Array, time: number) {
  if (
    data.length < 11 ||
    data[0] !== 0x96 ||
    data[1] !== 0x69 ||
    data[2] !== data.length
  )
    throw new Error('Invalid CDP identifier or length');
  const rate = rates[data[3] >>> 4];
  if (!rate || (data[3] & 15) !== 15 || !(data[4] & 1))
    throw new Error('Invalid CDP frame rate or marker');
  if (data.reduce((sum, byte) => sum + byte, 0) % 256)
    throw new Error('Invalid CDP checksum');
  const packets: CcData[] = [];
  const sections = new Set<number>();
  let at = 7,
    previous = 0x70;
  while (at < data.length) {
    const id = data[at++];
    if (id === 0x74) {
      if (
        at + 3 !== data.length ||
        data[at] !== data[5] ||
        data[at + 1] !== data[6]
      )
        throw new Error('Invalid CDP footer sequence');
      for (const [flag, section] of [
        [128, 0x71],
        [64, 0x72],
        [32, 0x73],
      ])
        if (!!(data[4] & flag) !== sections.has(section))
          throw new Error('CDP section flags disagree with payload');
      return { packets, duration: 1 / rate };
    }
    if (id < 0x71 || id > 0xef || id < previous || sections.has(id))
      throw new Error('Invalid CDP section order');
    sections.add(id);
    previous = id;
    if (id === 0x71) {
      at += 4;
    } else if (id === 0x72) {
      if (at >= data.length || (data[at] & 0xe0) !== 0xe0)
        throw new Error('Invalid CDP cc_count marker');
      const count = data[at++] & 31;
      if (at + 3 * count > data.length - 4)
        throw new Error('Truncated CDP cc_data');
      for (let i = 0; i < count; i++, at += 3) {
        if ((data[at] & 0xf8) !== 0xf8)
          throw new Error('Invalid CDP cc_data marker');
        if (data[at] & 4)
          packets.push({
            time,
            type: data[at] & 3,
            first: data[at + 1],
            second: data[at + 2],
          });
      }
    } else if (id === 0x73) {
      if (at >= data.length || !(data[at] & 128))
        throw new Error('Invalid CDP service marker');
      const flags = data[at++];
      if (((flags >>> 2) & 0x1c) !== (data[4] & 0x1c))
        throw new Error('CDP service flags disagree');
      at += (flags & 15) * 7;
    } else {
      if (at >= data.length) throw new Error('Truncated CDP extension');
      at += 1 + data[at];
    }
    if (at > data.length - 4) throw new Error('Truncated CDP section');
  }
  throw new Error('Missing CDP footer');
}

export function extract708(
  data: Uint8Array,
  metadata: FragmentTrack[],
  resourceOffset = 0,
): CcData[] {
  if (!metadata.some((t) => t.format === 'c708')) return [];
  if (metadata.filter((t) => t.format === 'c708').length > 1)
    throw new Error('Multiple c708 tracks are not yet supported');
  const packets: CcData[] = [];
  for (const sample of fragmentSamples(data, metadata, resourceOffset).filter(
    (s) => s.track.format === 'c708',
  )) {
    let elapsed = 0;
    for (const atom of boxes(sample.data)) {
      if (atom.type !== 'ccdp') continue;
      let at = 0;
      while (at < atom.body.length) {
        const size = atom.body[at + 2];
        if (!size || at + size > atom.body.length)
          throw new Error('Invalid ccdp packet length');
        if (elapsed >= sample.duration + 0.001)
          throw new Error('CDP cadence exceeds sample duration');
        const result = captionDistributionPacket(
          atom.body.subarray(at, at + size),
          sample.time + elapsed,
        );
        packets.push(...result.packets);
        elapsed += result.duration;
        at += size;
      }
    }
  }
  return packets;
}
