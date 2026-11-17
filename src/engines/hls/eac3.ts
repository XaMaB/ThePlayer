import { concat, type Sample, type Track } from './mp4';

/** ETSI TS 102 366 Annex E framing and Annex F sample configuration. */
export function eac3Header(data: Uint8Array, at = 0) {
  if (at + 7 > data.length || data[at] !== 11 || data[at + 1] !== 119)
    throw new Error('Invalid E-AC-3 sync');
  const type = data[at + 2] >>> 6,
    id = (data[at + 2] >>> 3) & 7,
    size = ((((data[at + 2] & 7) << 8) | data[at + 3]) + 1) * 2,
    fscod = data[at + 4] >>> 6,
    blockCode = (data[at + 4] >>> 4) & 3,
    acmod = (data[at + 4] >>> 1) & 7,
    lfe = data[at + 4] & 1,
    bsid = data[at + 5] >>> 3;
  if (type === 3 || bsid !== 16 || size < 7 || (fscod === 3 && blockCode === 3))
    throw new Error('Unsupported E-AC-3 header');
  const rate =
      fscod === 3
        ? [24000, 22050, 16000][blockCode]
        : [48000, 44100, 32000][fscod],
    blocks = fscod === 3 ? 6 : [1, 2, 3, 6][blockCode];
  return {
    type,
    id,
    size,
    fscod,
    blockCode,
    acmod,
    lfe,
    bsid,
    rate,
    blocks,
    channels: [2, 1, 2, 3, 3, 4, 4, 5][acmod] + lfe,
  };
}
function configuration(data: Uint8Array, h: ReturnType<typeof eac3Header>) {
  let bit = 45;
  const read = (n: number) => {
    if (bit + n > data.length * 8) throw new Error('Truncated E-AC-3 metadata');
    let value = 0;
    while (n--) {
      value = value * 2 + ((data[bit >>> 3] >>> (7 - (bit & 7))) & 1);
      bit++;
    }
    return value;
  };
  const skip = (n: number) => {
    while (n > 0) {
      const count = Math.min(n, 24);
      read(count);
      n -= count;
    }
  };
  skip(5);
  if (read(1)) skip(8);
  if (h.acmod === 0) {
    skip(5);
    if (read(1)) skip(8);
  }
  if (h.type === 1 && read(1)) skip(16);
  if (read(1)) {
    if (h.acmod > 2) skip(2);
    if (h.acmod & 1 && h.acmod > 2) skip(6);
    if (h.acmod & 4) skip(6);
    if (h.lfe && read(1)) skip(5);
    if (h.type === 0) {
      if (read(1)) skip(6);
      if (h.acmod === 0 && read(1)) skip(6);
      if (read(1)) skip(6);
      const mix = read(2);
      if (mix === 1) skip(5);
      else if (mix === 2) skip(12);
      else if (mix === 3) skip((read(5) + 2) * 8);
      if (h.acmod < 2) {
        if (read(1)) skip(14);
        if (h.acmod === 0 && read(1)) skip(14);
      }
      if (read(1)) {
        if (h.blocks === 1) skip(5);
        else for (let i = 0; i < h.blocks; i++) if (read(1)) skip(5);
      }
    }
  }
  return read(1) ? read(3) : 0;
}
export function eac3Samples(data: Uint8Array) {
  const samples: Sample[] = [],
    frames: Uint8Array[] = [];
  let first: ReturnType<typeof eac3Header> | undefined,
    bsmod = 0,
    blocks = 0,
    maxRate = 0;
  for (let at = 0; at < data.length; ) {
    const h = eac3Header(data, at);
    if (at + h.size > data.length) throw new Error('Incomplete E-AC-3 frame');
    if (h.type === 1 || h.id !== 0)
      throw new Error(
        'E-AC-3 dependent/multiple substreams require explicit support',
      );
    const frame = data.subarray(at, at + h.size),
      mode = configuration(frame, h);
    if (!first) {
      first = h;
      bsmod = mode;
    }
    if (
      h.rate !== first.rate ||
      h.acmod !== first.acmod ||
      h.lfe !== first.lfe ||
      mode !== bsmod
    )
      throw new Error('E-AC-3 configuration changed within a segment');
    maxRate = Math.max(
      maxRate,
      Math.ceil((h.size * 8 * h.rate) / (h.blocks * 256 * 1000)),
    );
    blocks += h.blocks;
    frames.push(frame);
    if (blocks > 6) throw new Error('E-AC-3 sample exceeds six blocks');
    if (blocks === 6) {
      samples.push({
        data: concat(...frames),
        duration: 1536,
        cts: 0,
        key: true,
      });
      frames.length = 0;
      blocks = 0;
    }
    at += h.size;
  }
  if (!first || blocks) throw new Error('Incomplete E-AC-3 six-block sample');
  const h = first,
    config = Uint8Array.of(
      maxRate >>> 5,
      (maxRate & 31) << 3,
      (h.fscod << 6) | (h.bsid << 1),
      (bsmod << 4) | (h.acmod << 1) | h.lfe,
      0,
    );
  const track: Track = {
    id: 2,
    kind: 'audio',
    timescale: h.rate,
    channels: h.channels,
    codec: 'ec-3',
    dec3: config,
  };
  return { track, samples };
}
