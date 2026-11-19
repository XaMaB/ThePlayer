import { boxes, type Track } from '../hls/mp4';
export interface ProducerClock {
  type: 'encoder' | 'captured';
  wallClockTime: number;
  mediaTime: number;
}
/** NTP era is selected nearest the synchronized client clock (2036 rollover). */
export function producerClocks(
  data: Uint8Array,
  tracks: Track[],
  now: number,
): ProducerClock[] {
  const clocks: ProducerClock[] = [];
  const top = boxes(data);
  const candidates = top.flatMap((b) =>
    b.type === 'moof' ? boxes(b.body) : [b],
  );
  for (const box of candidates) {
    if (box.type !== 'prft') continue;
    const d = box.body;
    if (d.length < 20 || d[0] > 1 || d.length !== (d[0] ? 24 : 20))
      throw new Error('Invalid DASH producer reference time');
    const v = new DataView(d.buffer, d.byteOffset, d.length);
    const flags = v.getUint32(0) & 0xffffff;
    if (flags !== 0 && flags !== 24) continue;
    const track = tracks.find((t) => t.id === v.getUint32(4));
    if (!track || !track.timescale) continue;
    const seconds = v.getUint32(8),
      fraction = v.getUint32(12) / 2 ** 32;
    const era = Math.round((now + 2208988800 - seconds) / 2 ** 32);
    const mediaTime = d[0] ? v.getBigUint64(16) : BigInt(v.getUint32(16));
    // Preserve integer seconds before converting a potentially 64-bit timestamp.
    const scale = BigInt(track.timescale);
    const whole = mediaTime / scale;
    if (whole > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('DASH producer timestamp exceeds precision limit');
    clocks.push({
      type: flags === 24 ? 'captured' : 'encoder',
      wallClockTime: seconds + era * 2 ** 32 + fraction - 2208988800,
      mediaTime: Number(whole) + Number(mediaTime % scale) / track.timescale,
    });
  }
  return clocks;
}
