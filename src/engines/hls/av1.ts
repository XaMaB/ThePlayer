/** AOM AV1 ISOBMFF v1.3.0, sections 2.3 and 5. Media OBUs stay untouched. */
export function normalizeAv1Codec(value: string): string | undefined {
  const input = value.trim();
  if (!/^av01\./i.test(input)) return;
  // Section 5: ignore an unrecognized character and everything following it.
  const codec = 'av01' + (input.slice(4).match(/^[.0-9MH]*/i)?.[0] ?? '');
  const match =
    /^av01\.([0-2])\.(\d{2})([MH])\.(08|10|12)(?:\.([01])\.([01][01][0-2])\.(\d{2})\.(\d{2})\.(\d{2})\.([01]))?$/i.exec(
      codec,
    );
  if (!match) return;
  const profile = Number(match[1]),
    level = Number(match[2]),
    depth = Number(match[4]);
  if (
    (level > 23 && level !== 31) ||
    (match[3].toUpperCase() === 'H' && level < 8) ||
    (depth === 12 && profile !== 2)
  )
    return;
  return `av01.${match[1]}.${match[2]}${match[3].toUpperCase()}.${match[4]}${match[5] == null ? '' : '.' + match.slice(5).join('.')}`;
}
export function av1Codec(config: Uint8Array, color?: Uint8Array): string {
  if (
    config.length < 4 ||
    config[0] !== 0x81 ||
    config[3] & 0xe0 ||
    (!(config[3] & 0x10) && config[3] & 15)
  )
    throw new Error('Invalid AV1 configuration record');
  const profile = config[1] >>> 5,
    level = config[1] & 31;
  const tier = config[2] & 128 ? 'H' : 'M';
  const high = !!(config[2] & 64),
    twelve = !!(config[2] & 32);
  if (twelve && (!high || profile !== 2))
    throw new Error('Invalid AV1 bit depth');
  const depth = twelve ? 12 : high ? 10 : 8;
  const mono = (config[2] >>> 4) & 1,
    x = (config[2] >>> 3) & 1,
    y = (config[2] >>> 2) & 1,
    position = config[2] & 3;
  if (
    position === 3 ||
    (!x && y) ||
    ((!x || !y) && position) ||
    (profile === 0 && (!x || !y)) ||
    (profile === 1 && (mono || x || y)) ||
    (mono && (!x || !y || position)) ||
    (profile === 2 && depth < 12 && !mono && (!x || y))
  )
    throw new Error('Invalid AV1 chroma configuration');
  let codec = `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;
  if (!normalizeAv1Codec(codec))
    throw new Error('Unsupported AV1 profile or level');
  if (color && String.fromCharCode(...color.subarray(0, 4)) === 'nclx') {
    if (color.length < 11) throw new Error('Truncated AV1 color information');
    const values = [4, 6, 8].map((i) => (color[i] << 8) | color[i + 1]);
    if (values.some((v) => v > 99))
      throw new Error('Unsupported AV1 color identifier');
    codec += `.${mono}.${x}${y}${position}.${values.map((v) => String(v).padStart(2, '0')).join('.')}.${color[10] >>> 7}`;
  }
  return codec;
}
