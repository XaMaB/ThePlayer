import { eac3Header } from './eac3';
import { ac3Header } from './ac3';
/** Original HLS sample encryption primitives, from Apple's MPEG-2 stream encryption specification. */
export async function decryptCbcBlocks(
  data: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (!data.length) return data.slice();
  if (data.length % 16 || iv.length !== 16)
    throw new Error('Invalid unpadded CBC block bounds');
  // Web Crypto always removes PKCS#7 padding. Append a computed padding block,
  // chained from the final ciphertext block, so all original plaintext survives.
  const padding = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: data.subarray(data.length - 16) as BufferSource },
      key,
      new Uint8Array(),
    ),
  );
  const padded = new Uint8Array(data.length + 16);
  padded.set(data);
  padded.set(padding, data.length);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: iv as BufferSource },
      key,
      padded,
    ),
  );
}

export function removeOuterPrevention(nal: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0)
      continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

export async function decryptAvcSample(
  nal: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (![1, 5].includes(nal[0] & 31) || nal.length <= 48) return nal.slice();
  // Encryption is applied to the already escaped NAL, then escaped a second time.
  // Remove only that outer escape layer; the decrypted bytes retain the original one.
  const data = removeOuterPrevention(nal);
  const positions: number[] = [];
  for (let at = 32; at + 16 < data.length; at += 160) positions.push(at);
  const cipher = new Uint8Array(positions.length * 16);
  positions.forEach((at, i) => cipher.set(data.subarray(at, at + 16), i * 16));
  const plain = await decryptCbcBlocks(cipher, key, iv);
  positions.forEach((at, i) =>
    data.set(plain.subarray(i * 16, i * 16 + 16), at),
  );
  return data;
}

export async function decryptAacSamples(
  data: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const out = data.slice();
  let at = 0;
  while (at < out.length) {
    if (at + 7 > out.length || out[at] !== 255 || (out[at + 1] & 0xf6) !== 0xf0)
      throw new Error('Invalid SAMPLE-AES ADTS header');
    const header = out[at + 1] & 1 ? 7 : 9;
    const length =
      ((out[at + 3] & 3) << 11) | (out[at + 4] << 3) | (out[at + 5] >>> 5);
    if (length < header || at + length > out.length)
      throw new Error('Truncated SAMPLE-AES AAC frame');
    if (out[at + 6] & 3)
      throw new Error('Multiple AAC raw data blocks are unsupported');
    const start = at + header + 16;
    const end =
      start + Math.max(0, Math.floor((length - header - 16) / 16)) * 16;
    if (end > start)
      out.set(await decryptCbcBlocks(out.subarray(start, end), key, iv), start);
    at += length;
  }
  return out;
}

export async function decryptAc3Samples(
  data: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
) {
  const out = data.slice();
  for (let at = 0; at < out.length; ) {
    const header = ac3Header(out, at);
    if (at + header.size > out.length)
      throw new Error('Truncated SAMPLE-AES AC-3 frame');
    const start = at + 16,
      end = start + Math.max(0, Math.floor((header.size - 16) / 16)) * 16;
    if (end > start)
      out.set(await decryptCbcBlocks(out.subarray(start, end), key, iv), start);
    at += header.size;
  }
  return out;
}

/** E-AC-3 chains encrypted blocks across syncframes in one six-block audio sample. */
export async function decryptEac3Samples(
  data: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
) {
  const out = data.slice();
  let blocks = 0;
  const ranges: { start: number; end: number }[] = [];
  for (let at = 0; at < out.length; ) {
    const h = eac3Header(out, at);
    if (h.type === 1 || h.id !== 0)
      throw new Error('Unsupported SAMPLE-AES E-AC-3 substreams');
    if (at + h.size > out.length)
      throw new Error('Truncated SAMPLE-AES E-AC-3 frame');
    const start = at + 16,
      end = start + Math.max(0, Math.floor((h.size - 16) / 16)) * 16;
    if (end > start) ranges.push({ start, end });
    blocks += h.blocks;
    if (blocks > 6) throw new Error('Invalid SAMPLE-AES E-AC-3 audio frame');
    if (blocks === 6) {
      if (ranges.length) {
        const clear = await decryptCbcBlocks(
          join(ranges.map((r) => out.subarray(r.start, r.end))),
          key,
          iv,
        );
        let offset = 0;
        for (const r of ranges) {
          out.set(clear.subarray(offset, offset + r.end - r.start), r.start);
          offset += r.end - r.start;
        }
      }
      blocks = 0;
      ranges.length = 0;
    }
    at += h.size;
  }
  if (blocks) throw new Error('Incomplete SAMPLE-AES E-AC-3 audio frame');
  return out;
}

interface SamplePes {
  type: number;
  pts?: number;
  dts?: number;
  data: Uint8Array;
}
const join = (pieces: Uint8Array[]) => {
  const result = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const piece of pieces) {
    result.set(piece, at);
    at += piece.length;
  }
  return result;
};

/** Decrypt complete elementary samples even when they straddle PES boundaries. */
export async function decryptSamplePes<T extends SamplePes>(
  input: T[],
  key: CryptoKey,
  iv: Uint8Array,
): Promise<T[]> {
  const output = input.map((p) => ({ ...p }));
  for (const kind of ['video', 'audio', 'ac3', 'eac3']) {
    const selected = output.filter((p) =>
      (kind === 'video'
        ? [0x1b, 0xdb]
        : kind === 'eac3'
          ? [0x87, 0xc2]
          : kind === 'ac3'
            ? [0x81, 0xc1]
            : [0x0f, 0xcf]
      ).includes(p.type),
    );
    if (!selected.length) continue;
    const source = join(selected.map((p) => p.data));
    let boundaries = [0];
    for (const p of selected)
      boundaries.push(boundaries.at(-1)! + p.data.length);
    let clear: Uint8Array;
    if (kind === 'audio') clear = await decryptAacSamples(source, key, iv);
    else if (kind === 'eac3') clear = await decryptEac3Samples(source, key, iv);
    else if (kind === 'ac3') clear = await decryptAc3Samples(source, key, iv);
    else {
      const starts: { at: number; header: number }[] = [];
      for (let i = 0; i + 2 < source.length; i++) {
        if (
          source[i] ||
          source[i + 1] ||
          !(source[i + 2] === 1 || (!source[i + 2] && source[i + 3] === 1))
        )
          continue;
        const header = i + (source[i + 2] === 1 ? 3 : 4);
        starts.push({ at: i, header });
        i = header - 1;
      }
      if (!starts.length) throw new Error('Missing SAMPLE-AES AVC start codes');
      const chunks: Uint8Array[] = [source.subarray(0, starts[0].at)];
      const spans: {
        begin: number;
        end: number;
        target: number;
        length: number;
      }[] = [];
      let target = starts[0].at;
      for (let i = 0; i < starts.length; i++) {
        const { at, header } = starts[i],
          end = starts[i + 1]?.at ?? source.length;
        const nal = await decryptAvcSample(
          source.subarray(header, end),
          key,
          iv,
        );
        const bytes = join([source.subarray(at, header), nal]);
        spans.push({ begin: at, end, target, length: bytes.length });
        chunks.push(bytes);
        target += bytes.length;
      }
      clear = join(chunks);
      boundaries = boundaries.map((at) => {
        if (at === source.length) return clear.length;
        const span = spans.find((s) => at >= s.begin && at < s.end);
        if (!span) return at;
        // An anchor inside a NAL remains inside that NAL after outer escapes shrink.
        return (
          span.target +
          Math.floor(
            ((at - span.begin) * span.length) / (span.end - span.begin),
          )
        );
      });
    }
    selected.forEach((p, i) => {
      p.data = clear.subarray(boundaries[i], boundaries[i + 1]);
      p.type =
        kind === 'video'
          ? 0x1b
          : kind === 'ac3'
            ? 0x81
            : kind === 'eac3'
              ? 0x87
              : 0x0f;
    });
  }
  return output;
}
