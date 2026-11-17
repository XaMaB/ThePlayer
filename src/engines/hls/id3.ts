export interface Id3Frame {
  id: string;
  data: Uint8Array;
  owner?: string;
  text?: string;
  description?: string;
  encoded?: boolean;
}
export interface Id3Tag {
  consumed: number;
  frames: Id3Frame[];
  timestamp?: number;
}
const ascii = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join('');
export function isId3(data: Uint8Array, at = 0) {
  return data[at] === 0x49 && data[at + 1] === 0x44 && data[at + 2] === 0x33;
}
function synchsafe(data: Uint8Array, at: number) {
  if (at + 4 > data.length || data.subarray(at, at + 4).some((b) => b & 128))
    throw new Error('Invalid ID3 synchsafe size');
  return (
    data[at] * 2 ** 21 +
    data[at + 1] * 2 ** 14 +
    data[at + 2] * 128 +
    data[at + 3]
  );
}
function unsync(data: Uint8Array) {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    out.push(data[i]);
    if (data[i] === 255 && data[i + 1] === 0) i++;
  }
  return Uint8Array.from(out);
}
function text(data: Uint8Array, encoding: number) {
  if (![0, 1, 2, 3].includes(encoding))
    throw new Error('Unknown ID3 text encoding');
  if (encoding === 0) return ascii(data).replace(/\0+$/, '');
  const name =
    encoding === 0
      ? 'latin1'
      : encoding === 3
        ? 'utf-8'
        : encoding === 2 || (data[0] === 254 && data[1] === 255)
          ? 'utf-16be'
          : 'utf-16le';
  return new TextDecoder(name).decode(data).replace(/\0+$/, '');
}
function terminator(data: Uint8Array, wide: boolean) {
  for (let i = 0; i < data.length; i += wide ? 2 : 1)
    if (data[i] === 0 && (!wide || data[i + 1] === 0)) return i;
  return data.length;
}
/** ID3 v2.3/v2.4 framing; unknown or encoded frames remain available as bytes. */
export function parseId3(input: Uint8Array): Id3Tag {
  if (!isId3(input) || input.length < 10)
    throw new Error('Missing or truncated ID3 header');
  const version = input[3],
    flags = input[5];
  if (
    ![3, 4].includes(version) ||
    input[4] === 255 ||
    flags & (version === 3 ? 31 : 15)
  )
    throw new Error('Unsupported ID3 header');
  const size = synchsafe(input, 6),
    footer = version === 4 && !!(flags & 16),
    consumed = 10 + size + (footer ? 10 : 0);
  if (size > 16 * 1024 * 1024 || consumed > input.length)
    throw new Error('Truncated or oversized ID3 tag');
  if (footer) {
    const f = input.subarray(10 + size, consumed);
    if (
      ascii(f.subarray(0, 3)) !== '3DI' ||
      f.subarray(3).some((b, i) => b !== input[i + 3])
    )
      throw new Error('Invalid ID3 footer');
  }
  let data = input.subarray(10, 10 + size);
  if (version === 3 && flags & 128) data = unsync(data);
  let at = 0;
  if (flags & 64) {
    if (data.length < 4) throw new Error('Truncated ID3 extended header');
    at =
      version === 4
        ? synchsafe(data, 0)
        : new DataView(data.buffer, data.byteOffset).getUint32(0) + 4;
    if (at < (version === 4 ? 6 : 10) || at > data.length)
      throw new Error('Invalid ID3 extended header');
  }
  const frames: Id3Frame[] = [];
  let timestamp: number | undefined;
  while (at < data.length) {
    if (data[at] === 0) {
      if (data.subarray(at).some((b) => b !== 0))
        throw new Error('Invalid ID3 padding');
      break;
    }
    if (at + 10 > data.length) throw new Error('Truncated ID3 frame header');
    const id = ascii(data.subarray(at, at + 4)),
      length =
        version === 4
          ? synchsafe(data, at + 4)
          : new DataView(data.buffer, data.byteOffset + at).getUint32(4),
      format = data[at + 9];
    if (!/^[A-Z0-9]{4}$/.test(id) || !length || at + 10 + length > data.length)
      throw new Error('Invalid ID3 frame bounds');
    let body = data.subarray(at + 10, at + 10 + length);
    at += 10 + length;
    if (version === 4 && (flags & 128 || format & 2)) body = unsync(body);
    const frame: Id3Frame = { id, data: body.slice() };
    if (format & (version === 3 ? 0xc0 : 0x0c)) {
      frame.encoded = true;
      frames.push(frame);
      continue;
    }
    if (format & (version === 3 ? 0x20 : 0x40)) body = body.subarray(1);
    if (version === 4 && format & 1) {
      const declared = synchsafe(body, 0);
      body = body.subarray(4);
      if (declared !== body.length) throw new Error('ID3 data length mismatch');
    }
    frame.data = body.slice();
    if (id === 'PRIV') {
      const end = body.indexOf(0);
      if (end < 0) throw new Error('Missing ID3 private owner terminator');
      frame.owner = ascii(body.subarray(0, end));
      frame.data = body.slice(end + 1);
      if (frame.owner === 'com.apple.streaming.transportStreamTimestamp') {
        if (frame.data.length !== 8)
          throw new Error('Invalid packed audio timestamp length');
        const value = new DataView(
          frame.data.buffer,
          frame.data.byteOffset,
        ).getBigUint64(0);
        if (value >= 2n ** 33n)
          throw new Error('Packed audio timestamp exceeds 33 bits');
        if (timestamp != null && timestamp !== Number(value))
          throw new Error('Conflicting packed audio timestamps');
        timestamp = Number(value);
      }
    } else if (id[0] === 'T' && body.length) {
      if (id === 'TXXX') {
        const rest = body.subarray(1),
          wide = body[0] === 1 || body[0] === 2,
          end = terminator(rest, wide);
        frame.description = text(rest.subarray(0, end), body[0]);
        frame.text = text(
          rest.subarray(Math.min(rest.length, end + (wide ? 2 : 1))),
          body[0] === 1 && rest[0] === 254 && rest[1] === 255 ? 2 : body[0],
        );
      } else frame.text = text(body.subarray(1), body[0]);
    }
    frames.push(frame);
    if (frames.length > 4096) throw new Error('Too many ID3 frames');
  }
  return { consumed, frames, timestamp };
}
