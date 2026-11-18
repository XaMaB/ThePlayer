export const sampleRates = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
/** ADTS describes the LC core. A declared HE-AAC rendition supplies the SBR profile. */
export function aacConfiguration(
  index: number,
  channels: number,
  codec = 'mp4a.40.2',
) {
  const coreRate = sampleRates[index];
  if (!coreRate || channels < 1 || channels > 7)
    throw new Error('Unsupported AAC configuration');
  const ps = codec === 'mp4a.40.29';
  if (ps && channels !== 1)
    throw new Error('HE-AAC v2 requires a mono AAC core');
  if (codec !== 'mp4a.40.5' && !ps)
    return {
      rate: coreRate,
      channels,
      duration: 1024,
      codec: 'mp4a.40.2',
      asc: new Uint8Array([
        (2 << 3) | (index >>> 1),
        ((index & 1) << 7) | (channels << 3),
      ]),
    };
  const outputIndex = sampleRates.indexOf(coreRate * 2);
  if (outputIndex < 0) throw new Error('Unsupported HE-AAC output rate');
  // AudioSpecificConfig: SBR AOT, core frequency, channels, output frequency,
  // AAC-LC extension AOT and GASpecificConfig (1024 samples, no dependency).
  const bits = [
    [ps ? 29 : 5, 5],
    [index, 4],
    [channels, 4],
    [outputIndex, 4],
    [2, 5],
    [0, 3],
  ];
  const asc = new Uint8Array(4);
  let at = 0;
  for (const [value, length] of bits)
    for (let n = length - 1; n >= 0; n--, at++)
      asc[at >>> 3] |= ((value >>> n) & 1) << (7 - (at & 7));
  return {
    rate: coreRate * 2,
    channels: ps ? 2 : channels,
    duration: 2048,
    codec,
    asc,
  };
}
