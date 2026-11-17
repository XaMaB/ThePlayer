import { boxes } from './mp4';
import { parseId3, type Id3Frame } from './id3';
export interface TimedMetadata {
  type: 'id3' | 'emsg';
  time: number;
  frames: Id3Frame[];
  scheme?: string;
  value?: string;
  id?: number;
  duration?: number;
  data?: Uint8Array;
}
/** Read event messages without changing byte positions used by the fragment. */
export function emsgMetadata(
  data: Uint8Array,
  earliestPresentationTime: number | (() => number),
): TimedMetadata[] {
  const events = boxes(data).flatMap((b) =>
    b.type === 'moof'
      ? boxes(b.body).filter((child) => child.type === 'emsg')
      : b.type === 'emsg'
        ? [b]
        : [],
  );
  return events.map(({ body }) => {
    if (body.length < 4 || body[0] > 1 || body[1] || body[2] || body[3])
      throw new Error('Invalid emsg header');
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let at = 4;
    const number = () => {
      if (at + 4 > body.length) throw new Error('Truncated emsg number');
      const n = view.getUint32(at);
      at += 4;
      return n;
    };
    const string = () => {
      const end = body.indexOf(0, at);
      if (end < 0) throw new Error('Unterminated emsg string');
      const value = new TextDecoder('utf-8', { fatal: true }).decode(
        body.subarray(at, end),
      );
      at = end + 1;
      return value;
    };
    let scheme: string,
      value: string,
      scale: number,
      time: number,
      duration: number,
      id: number;
    if (body[0] === 0) {
      scheme = string();
      value = string();
      scale = number();
      time =
        (typeof earliestPresentationTime === 'function'
          ? earliestPresentationTime()
          : earliestPresentationTime) +
        number() / scale;
      duration = number();
      id = number();
    } else {
      scale = number();
      const high = number(),
        low = number(),
        stamp = high * 2 ** 32 + low;
      if (!Number.isSafeInteger(stamp))
        throw new Error('Unsafe emsg presentation timestamp');
      time = stamp / scale;
      duration = number();
      id = number();
      scheme = string();
      value = string();
    }
    if (!scale || !Number.isFinite(time))
      throw new Error('Invalid emsg timescale');
    const payload = body.slice(at),
      frames: Id3Frame[] = [];
    const id3 = [
      'https://aomedia.org/emsg/ID3',
      'https://developer.apple.com/streaming/emsg-id3',
    ].includes(scheme);
    if (id3) {
      if (body[0] !== 1 || payload[3] !== 4)
        throw new Error('CMAF ID3 requires emsg v1 and ID3 v2.4');
      const parsed = parseId3(payload);
      if (parsed.consumed !== payload.length)
        throw new Error('Trailing CMAF ID3 bytes');
      frames.push(...parsed.frames);
    }
    return {
      type: id3 ? 'id3' : 'emsg',
      time,
      scheme,
      value,
      id,
      duration: duration === 0xffffffff ? undefined : duration / scale,
      data: payload,
      frames,
    };
  });
}

/** The application consumes emsg; hide it from MSE without moving sample offsets. */
export function filterEmsg(input: Uint8Array): Uint8Array {
  const positions: number[] = [];
  for (const top of boxes(input)) {
    if (top.type === 'emsg') positions.push(top.at);
    if (top.type === 'moof')
      for (const child of boxes(top.body))
        if (child.type === 'emsg')
          positions.push(top.body.byteOffset - input.byteOffset + child.at);
  }
  if (!positions.length) return input;
  const data = input.slice();
  for (const at of positions) data.set([102, 114, 101, 101], at + 4);
  return data;
}
