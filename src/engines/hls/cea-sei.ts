import { fragmentSamples, type FragmentTrack } from './fragment-samples';
export interface CcData {
  time: number;
  type: number;
  first: number;
  second: number;
}
/** ATSC A/53 registered user data inside an ITU-T T.35 SEI message. */
export function registeredCaptions(
  payload: Uint8Array,
  time: number,
): CcData[] {
  if (
    payload.length < 8 ||
    payload[0] !== 0xb5 ||
    payload[1] !== 0 ||
    payload[2] !== 0x31 ||
    String.fromCharCode(...payload.subarray(3, 7)) !== 'GA94' ||
    payload[7] !== 3
  )
    return [];
  if (payload.length < 10) throw new Error('Truncated ATSC caption header');
  if (!(payload[8] & 0x40)) return [];
  const count = payload[8] & 31;
  if (payload.length < 11 + count * 3)
    throw new Error('Truncated ATSC caption data');
  if (payload[10 + count * 3] !== 0xff)
    throw new Error('Invalid ATSC caption terminator');
  const packets: CcData[] = [];
  for (let i = 0; i < count; i++) {
    const at = 10 + i * 3;
    if ((payload[at] & 0xf8) !== 0xf8)
      throw new Error('Invalid caption marker bits');
    if (payload[at] & 4)
      packets.push({
        time,
        type: payload[at] & 3,
        first: payload[at + 1],
        second: payload[at + 2],
      });
  }
  return packets;
}
export function seiCaptions(
  nal: Uint8Array,
  hevc: boolean,
  time: number,
): CcData[] {
  const type = hevc ? (nal[0] >>> 1) & 63 : nal[0] & 31;
  if (hevc ? ![39, 40].includes(type) : type !== 6) return [];
  const rbsp: number[] = [];
  for (let i = hevc ? 2 : 1; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0)
      continue;
    rbsp.push(nal[i]);
  }
  const bytes = Uint8Array.from(rbsp),
    packets: CcData[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (
      bytes[at] === 0x80 &&
      bytes.subarray(at + 1).every((value) => value === 0)
    )
      break;
    let payloadType = 0,
      size = 0;
    while (at < bytes.length && bytes[at] === 255) {
      payloadType += 255;
      at++;
    }
    if (at >= bytes.length) throw new Error('Truncated SEI payload type');
    payloadType += bytes[at++];
    while (at < bytes.length && bytes[at] === 255) {
      size += 255;
      at++;
    }
    if (at >= bytes.length) throw new Error('Truncated SEI payload size');
    size += bytes[at++];
    if (at + size > bytes.length) throw new Error('Truncated SEI payload');
    if (payloadType === 4)
      packets.push(...registeredCaptions(bytes.subarray(at, at + size), time));
    at += size;
  }
  return packets;
}
export function mp4SeiCaptions(
  data: Uint8Array,
  metadata: FragmentTrack[],
  resourceOffset = 0,
): CcData[] {
  if (!metadata.some((track) => track.nalLength)) return [];
  const packets: CcData[] = [];
  for (const sample of fragmentSamples(data, metadata, resourceOffset)) {
    const lengthSize = sample.track.nalLength;
    if (!lengthSize) continue;
    let at = 0;
    while (at < sample.data.length) {
      if (at + lengthSize > sample.data.length)
        throw new Error('Truncated NAL length');
      let size = 0;
      for (let i = 0; i < lengthSize; i++)
        size = size * 256 + sample.data[at++];
      if (!size || at + size > sample.data.length)
        throw new Error('Invalid caption NAL bounds');
      packets.push(
        ...seiCaptions(
          sample.data.subarray(at, at + size),
          /^(hvc1|hev1)$/.test(sample.track.format),
          sample.time,
        ),
      );
      at += size;
    }
  }
  return packets;
}
