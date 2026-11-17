/** HEVC decoder configuration, parsed from ISO/IEC 23008-2 parameter sets. */
class Bits {
  private at = 0;
  constructor(private data: Uint8Array) {}
  read(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++, this.at++) {
      if (this.at >= this.data.length * 8)
        throw new Error('Truncated HEVC SPS');
      value =
        value * 2 + ((this.data[this.at >>> 3] >>> (7 - (this.at & 7))) & 1);
    }
    return value;
  }
  ue(): number {
    let zeros = 0;
    while (!this.read(1))
      if (++zeros > 30) throw new Error('Invalid HEVC Exp-Golomb');
    return 2 ** zeros - 1 + this.read(zeros);
  }
}
export function hevcCodec(config: Uint8Array, entry = 'hvc1'): string {
  if (config.length < 23 || config[0] !== 1)
    throw new Error('Invalid hvcC configuration');
  let compatibility = 0;
  for (let bit = 0; bit < 32; bit++)
    compatibility +=
      ((config[2 + (bit >>> 3)] >>> (7 - (bit & 7))) & 1) * 2 ** bit;
  const constraints = Array.from(config.subarray(6, 12));
  while (constraints.at(-1) === 0) constraints.pop();
  const suffix = constraints
    .map((n) => n.toString(16).padStart(2, '0').toUpperCase())
    .join('.');
  return `${entry}.${['', 'A', 'B', 'C'][config[1] >>> 6]}${config[1] & 31}.${compatibility.toString(16).toUpperCase()}.${config[1] & 32 ? 'H' : 'L'}${config[12]}${suffix ? '.' + suffix : ''}`;
}
export function hevcConfiguration(
  vps: Uint8Array,
  sps: Uint8Array,
  pps: Uint8Array,
) {
  const raw: number[] = [];
  for (let i = 2; i < sps.length; i++) {
    if (i >= 4 && sps[i] === 3 && sps[i - 1] === 0 && sps[i - 2] === 0)
      continue;
    raw.push(sps[i]);
  }
  const b = new Bits(new Uint8Array(raw));
  b.read(4);
  const layers = b.read(3),
    nesting = b.read(1);
  if (layers > 6) throw new Error('Invalid HEVC temporal layers');
  const profile = b.read(8);
  const compatibility = Array.from({ length: 4 }, () => b.read(8));
  const constraints = Array.from({ length: 6 }, () => b.read(8));
  const level = b.read(8);
  const sub = Array.from({ length: layers }, () => [b.read(1), b.read(1)]);
  if (layers) b.read((8 - layers) * 2);
  for (const [profilePresent, levelPresent] of sub) {
    if (profilePresent) for (let i = 0; i < 11; i++) b.read(8);
    if (levelPresent) b.read(8);
  }
  b.ue();
  const chroma = b.ue();
  if (chroma > 3) throw new Error('Invalid HEVC chroma format');
  const separate = chroma === 3 ? b.read(1) : 0;
  let width = b.ue(),
    height = b.ue();
  if (b.read(1)) {
    const left = b.ue(),
      right = b.ue(),
      top = b.ue(),
      bottom = b.ue();
    width -=
      (left + right) * (!separate && (chroma === 1 || chroma === 2) ? 2 : 1);
    height -= (top + bottom) * (!separate && chroma === 1 ? 2 : 1);
  }
  const luma = b.ue(),
    chromaDepth = b.ue();
  if (
    width < 1 ||
    height < 1 ||
    width > 65535 ||
    height > 65535 ||
    luma > 7 ||
    chromaDepth > 7
  )
    throw new Error('Unsupported HEVC dimensions or bit depth');
  const sets = [vps, sps, pps];
  const config = new Uint8Array(
    23 + sets.reduce((size, set) => size + 5 + set.length, 0),
  );
  config.set([
    1,
    profile,
    ...compatibility,
    ...constraints,
    level,
    0xf0,
    0,
    0xfc,
    0xfc | chroma,
    0xf8 | luma,
    0xf8 | chromaDepth,
    0,
    0,
    ((layers + 1) << 3) | (nesting << 2) | 3,
    3,
  ]);
  let at = 23;
  sets.forEach((set, i) => {
    if (set.length > 65535 || ((set[0] >>> 1) & 63) !== 32 + i)
      throw new Error('Invalid HEVC parameter set');
    config.set([0x80 | (32 + i), 0, 1, set.length >>> 8, set.length & 255], at);
    config.set(set, at + 5);
    at += 5 + set.length;
  });
  return { width, height, hvcc: config, codec: hevcCodec(config) };
}
