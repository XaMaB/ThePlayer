import type { Sample, Track } from './mp4';
const bitrates = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512,
  576, 640,
];
const channels = [2, 1, 2, 3, 3, 4, 4, 5];
export function ac3Header(data: Uint8Array, at = 0) {
  if (at + 7 > data.length || data[at] !== 0x0b || data[at + 1] !== 0x77)
    throw new Error('Invalid AC-3 sync');
  const fscod = data[at + 4] >>> 6,
    code = data[at + 4] & 63,
    bsid = data[at + 5] >>> 3,
    bsmod = data[at + 5] & 7,
    acmod = data[at + 6] >>> 5;
  if (fscod === 3 || code > 37 || bsid > 10)
    throw new Error('Unsupported AC-3 header');
  const rate = [48000, 44100, 32000][fscod] / 2 ** Math.max(0, bsid - 8),
    index = code >>> 1,
    bitrate = bitrates[index];
  const words =
      fscod === 0
        ? bitrate * 2
        : fscod === 2
          ? bitrate * 3
          : Math.floor((bitrate * 320) / 147) + (code & 1),
    size = words * 2;
  let bit = at * 8 + 51;
  if (acmod & 1 && acmod !== 1) bit += 2;
  if (acmod & 4) bit += 2;
  if (acmod === 2) bit += 2;
  if (bit >= data.length * 8) throw new Error('Truncated AC-3 channel header');
  const lfe = (data[bit >>> 3] >>> (7 - (bit & 7))) & 1;
  const packed =
    (fscod << 22) |
    (bsid << 17) |
    (bsmod << 14) |
    (acmod << 11) |
    (lfe << 10) |
    (index << 5);
  const config = Uint8Array.of(
    packed >>> 16,
    (packed >>> 8) & 255,
    packed & 255,
  );
  return {
    rate,
    size,
    channels: channels[acmod] + lfe,
    config,
    bsid,
    bsmod,
    acmod,
    lfe,
  };
}
export function ac3Samples(data: Uint8Array) {
  const samples: Sample[] = [];
  let track: Track | undefined;
  for (let at = 0; at < data.length; ) {
    const header = ac3Header(data, at);
    if (at + header.size > data.length)
      throw new Error('Incomplete AC-3 frame');
    if (!track)
      track = {
        id: 2,
        kind: 'audio',
        timescale: header.rate,
        channels: header.channels,
        codec: 'ac-3',
        dac3: header.config,
      };
    if (
      track.timescale !== header.rate ||
      track.channels !== header.channels ||
      track.dac3!.some((b, i) => b !== header.config[i])
    )
      throw new Error('AC-3 configuration changed within a segment');
    samples.push({
      data: data.subarray(at, at + header.size),
      duration: 1536,
      cts: 0,
      key: true,
    });
    at += header.size;
  }
  if (!track) throw new Error('No AC-3 samples');
  return { track, samples };
}
