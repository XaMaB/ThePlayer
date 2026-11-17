/** MPEG-1/2/2.5 Layer III frame headers; free-format frames require separate length discovery. */
export function mp3Header(data: Uint8Array, at = 0) {
  if (
    at + 4 > data.length ||
    data[at] !== 255 ||
    (data[at + 1] & 0xe0) !== 0xe0
  )
    throw new Error('Invalid MPEG audio sync');
  const version = (data[at + 1] >>> 3) & 3,
    layer = (data[at + 1] >>> 1) & 3,
    bitrateIndex = data[at + 2] >>> 4,
    rateIndex = (data[at + 2] >>> 2) & 3;
  if (
    version === 1 ||
    layer !== 1 ||
    bitrateIndex === 0 ||
    bitrateIndex === 15 ||
    rateIndex === 3
  )
    throw new Error('Unsupported MPEG Layer III header');
  const rates = [44100, 48000, 32000],
    v1 = version === 3;
  const bitrates = v1
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const rate = rates[rateIndex] / (v1 ? 1 : version === 2 ? 2 : 4),
    bitrate = bitrates[bitrateIndex] * 1000;
  const size =
      Math.floor(((v1 ? 144 : 72) * bitrate) / rate) +
      ((data[at + 2] >>> 1) & 1),
    samples = v1 ? 1152 : 576,
    channels = data[at + 3] >>> 6 === 3 ? 1 : 2;
  return { rate, bitrate, size, samples, channels, version };
}
