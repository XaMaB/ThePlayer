import { build } from 'esbuild';
const built = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/mp4'; export * from './src/subtitles/cea708/decoder'; export * from './src/engines/hls/cea708-service';",
    resolveDir: new URL('../..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
export const {
  initialization,
  fragment,
  concat,
  Cea708Decoder,
  Cea708Service,
} = await import(
  'data:text/javascript;base64,' +
    Buffer.from(built.outputFiles[0].text).toString('base64')
);
export const track = {
  id: 1,
  kind: 'video',
  timescale: 90000,
  codec: 'avc1.64001f',
  width: 1920,
  height: 1080,
  sps: Uint8Array.of(0x67, 0x64, 0, 0x1f),
  pps: Uint8Array.of(0x68, 0),
};
export const init = initialization([track]);
export const define = (id = 0) => [0x98 + id, 0x38, 0x80 | 75, 30, 1, 41, 9];
export function packet(commands, service = 1, sequence = 0) {
  const bytes =
    service < 7
      ? [(service << 5) | commands.length, ...commands]
      : [0xe0 | commands.length, service, ...commands];
  if (bytes.length % 2 === 0) bytes.push(0);
  const pairs = [
    {
      type: 3,
      first: (sequence % 4 << 6) | ((bytes.length + 1) / 2),
      second: bytes[0],
    },
  ];
  for (let i = 1; i < bytes.length; i += 2)
    pairs.push({ type: 2, first: bytes[i], second: bytes[i + 1] });
  return pairs;
}
export function sei(pairs, hevc = false) {
  const payload = [
    0xb5,
    0,
    0x31,
    0x47,
    0x41,
    0x39,
    0x34,
    3,
    0x40 | pairs.length,
    0xff,
    ...pairs.flatMap((p) => [0xfc | p.type, p.first, p.second]),
    0xff,
  ];
  const rbsp = [4, payload.length, ...payload, 0x80],
    escaped = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      escaped.push(3);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  const nal = Uint8Array.from([...(hevc ? [78, 1] : [6]), ...escaped]);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, nal.length);
  return concat(length, nal);
}
export function media(pairs, time = 1, duration = 1, cts = 0, t = track) {
  return fragment(
    t,
    [
      {
        data: sei(pairs, !!t.hvcc),
        duration: Math.round(duration * t.timescale),
        cts: Math.round(cts * t.timescale),
        key: true,
      },
    ],
    Math.round(time * t.timescale),
    Math.round(time * 10) + 1,
  );
}
export const plain = (s) =>
  s.windows
    .get(0)
    .cells.map((row) =>
      row
        .map((c) => c?.text ?? ' ')
        .join('')
        .trimEnd(),
    )
    .join('\n')
    .trimEnd();
