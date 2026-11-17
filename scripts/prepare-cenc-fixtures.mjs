/** Generate clear-key CENC test media using Node crypto and explicit BMFF boxes. */
import { build } from 'esbuild';
import { createCipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
async function module(name) {
  const r = await build({
    entryPoints: [
      new URL('../src/engines/hls/' + name + '.ts', import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    format: 'esm',
  });
  return import(
    'data:text/javascript;base64,' +
      Buffer.from(r.outputFiles[0].text).toString('base64')
  );
}
const { box, boxes, concat, u32 } = await module('mp4');
const { fragmentMetadata, fragmentSamples } = await module('fragment-samples');
const ascii = (s) => new TextEncoder().encode(s);
const u16 = (n) => Uint8Array.of(n >>> 8, n & 255);
for (const mode of [
  'cenc',
  'cbcs',
  'cbcs-constant',
  'cenc-key2',
  'cbcs-key2',
]) {
  const key = Buffer.alloc(16, mode.endsWith('-key2') ? 0x3a : 0x39);
  const kid = Buffer.from(
    mode.endsWith('-key2')
      ? '0123456789abcdef0123456789abcdee'
      : '0123456789abcdef0123456789abcdef',
    'hex',
  );
  const scheme = mode.split('-')[0],
    constant = mode.endsWith('-constant');
  const constantIv = Buffer.alloc(16, 0x25);
  const init = new Uint8Array(await readFile(path.join(root, 'fmp4/init.mp4'))),
    metadata = fragmentMetadata(init);
  const containers = ['moov', 'trak', 'mdia', 'minf', 'stbl'];
  function protect(data) {
    return concat(
      ...boxes(data).map((b) => {
        if (containers.includes(b.type)) return box(b.type, protect(b.body));
        if (b.type !== 'stsd') return box(b.type, b.body);
        return box(
          'stsd',
          b.body.subarray(0, 8),
          ...boxes(b.body.subarray(8)).map((entry) => {
            if (!['avc1', 'avc3', 'mp4a'].includes(entry.type))
              throw Error('Fixture unsupported entry');
            const sinf = box(
              'sinf',
              box('frma', ascii(entry.type)),
              box('schm', new Uint8Array(4), ascii(scheme), u32(0x10000)),
              box(
                'schi',
                box(
                  'tenc',
                  Uint8Array.of(
                    scheme === 'cbcs' ? 1 : 0,
                    0,
                    0,
                    0,
                    0,
                    scheme === 'cbcs' && entry.type !== 'mp4a' ? 0x19 : 0,
                    1,
                    constant ? 0 : 16,
                  ),
                  kid,
                  ...(constant ? [Uint8Array.of(16), constantIv] : []),
                ),
              ),
            );
            return box(
              entry.type === 'mp4a' ? 'enca' : 'encv',
              entry.body,
              sinf,
            );
          }),
        );
      }),
    );
  }
  const pssh = box(
    'pssh',
    Uint8Array.of(1, 0, 0, 0),
    Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex'),
    u32(1),
    kid,
    u32(0),
  );
  const encryptedInit = concat(
    ...boxes(protect(init)).map((b) =>
      b.type === 'moov' ? box('moov', b.body, pssh) : box(b.type, b.body),
    ),
  );
  const dir = path.join(root, mode);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'init.mp4'), encryptedInit);
  const playlist = await readFile(path.join(root, 'fmp4/index.m3u8'), 'utf8');
  await writeFile(
    path.join(dir, 'index.m3u8'),
    playlist.replace(
      '#EXT-X-MAP',
      `#EXT-X-KEY:METHOD=${scheme === 'cbcs' ? 'SAMPLE-AES' : 'SAMPLE-AES-CTR'},URI="license",KEYFORMAT="org.w3.clearkey"\n#EXT-X-MAP`,
    ),
  );
  await writeFile(path.join(dir, 'key.bin'), key);
  await writeFile(
    path.join(dir, 'identity.m3u8'),
    playlist.replace(
      '#EXT-X-MAP',
      `#EXT-X-KEY:METHOD=${scheme === 'cbcs' ? 'SAMPLE-AES' : 'SAMPLE-AES-CTR'},URI="key.bin"\n#EXT-X-MAP`,
    ),
  );
  let serial = 0;
  for (const name of playlist.split('\n').filter((l) => l.endsWith('.m4s'))) {
    const source = new Uint8Array(
      await readFile(path.join(root, 'fmp4', name)),
    );
    const samples = fragmentSamples(source, metadata),
      entries = new Map();
    for (const sample of samples) {
      const iv = constant ? constantIv : Buffer.alloc(16);
      if (!constant) iv.writeUInt32BE(++serial, 12);
      const cipher = createCipheriv('aes-128-ctr', key, iv),
        subs = [];
      const encrypt = (bytes) => {
        if (scheme === 'cenc') return cipher.update(bytes);
        const out = Buffer.from(bytes),
          blockCipher = createCipheriv('aes-128-cbc', key, iv);
        blockCipher.setAutoPadding(false);
        for (
          let at = 0;
          at + 16 <= out.length;
          at += sample.track.video ? 160 : 16
        )
          out.set(blockCipher.update(out.subarray(at, at + 16)), at);
        blockCipher.final();
        return out;
      };
      if (sample.track.video) {
        const length = sample.track.nalLength;
        if (length !== 4) throw Error('Fixture NAL width');
        for (let at = 0; at < sample.data.length; ) {
          const size = new DataView(
            sample.data.buffer,
            sample.data.byteOffset + at,
            4,
          ).getUint32(0);
          if (!size || at + 4 + size > sample.data.length)
            throw Error('Fixture NAL bounds');
          const clear = 5,
            protectedSize = size - 1;
          sample.data.set(
            encrypt(sample.data.subarray(at + clear, at + 4 + size)),
            at + clear,
          );
          subs.push(concat(u16(clear), u32(protectedSize)));
          at += 4 + size;
        }
      } else sample.data.set(encrypt(sample.data));
      cipher.final();
      const list = entries.get(sample.track.id) ?? [];
      list.push(
        concat(
          ...(constant ? [] : [iv]),
          ...(sample.track.video ? [u16(subs.length), ...subs] : []),
        ),
      );
      entries.set(sample.track.id, list);
    }
    const tops = boxes(source);
    const output = [];
    for (const top of tops) {
      if (top.type === 'sidx') continue;
      if (top.type !== 'moof') {
        output.push(box(top.type, top.body));
        continue;
      }
      const extras = new Map();
      for (const traf of boxes(top.body).filter((b) => b.type === 'traf')) {
        const head = boxes(traf.body).find((b) => b.type === 'tfhd').body;
        const id = new DataView(head.buffer, head.byteOffset).getUint32(4),
          list = entries.get(id),
          video = metadata.find((t) => t.id === id).video;
        extras.set(
          traf,
          box(
            'senc',
            Uint8Array.of(0, 0, 0, video ? 2 : 0),
            u32(list.length),
            ...list,
          ),
        );
      }
      const growth = [...extras.values()].reduce((n, b) => n + b.length, 0);
      output.push(
        box(
          'moof',
          ...boxes(top.body).map((b) => {
            if (b.type !== 'traf') return box(b.type, b.body);
            const entry = [...extras].find(
              ([t]) => t.body.byteOffset === b.body.byteOffset,
            )[1];
            return box(
              'traf',
              ...boxes(b.body).map((child) => {
                if (child.type !== 'trun') return box(child.type, child.body);
                const body = child.body.slice(),
                  view = new DataView(body.buffer);
                if (!(body[3] & 1)) throw Error('Fixture trun offset required');
                view.setInt32(8, view.getInt32(8) + growth);
                return box('trun', body);
              }),
              entry,
            );
          }),
        ),
      );
    }
    await writeFile(path.join(dir, name), concat(...output));
  }
  await writeFile(
    path.join(dir, 'keys.json'),
    JSON.stringify({ [kid.toString('hex')]: key.toString('hex') }),
  );
  console.log(
    'Prepared CENC AVC/AAC with common PSSH and per-sample IV/subsamples',
  );
}

for (const scheme of ['cenc', 'cbcs']) {
  const dir = path.join(root, scheme + '-rotation');
  await mkdir(dir, { recursive: true });
  for (const index of [0, 1]) {
    const source = path.join(root, scheme + (index ? '-key2' : ''));
    await writeFile(
      path.join(dir, `init${index}.mp4`),
      await readFile(path.join(source, 'init.mp4')),
    );
    await writeFile(
      path.join(dir, `key${index}.bin`),
      await readFile(path.join(source, 'key.bin')),
    );
  }
  const original = await readFile(path.join(root, 'fmp4/index.m3u8'), 'utf8');
  let sequence = 0,
    media = '',
    identity = '';
  for (const line of original.split('\n')) {
    if (line.startsWith('#EXT-X-MAP')) continue;
    if (line.endsWith('.m4s')) {
      const index = sequence++ % 2;
      const method = scheme === 'cbcs' ? 'SAMPLE-AES' : 'SAMPLE-AES-CTR';
      media += `#EXT-X-KEY:METHOD=${method},URI="license",KEYFORMAT="org.w3.clearkey"\n#EXT-X-MAP:URI="init${index}.mp4"\n`;
      identity += `#EXT-X-KEY:METHOD=${method},URI="key${index}.bin"\n#EXT-X-MAP:URI="init${index}.mp4"\n`;
      await writeFile(
        path.join(dir, line),
        await readFile(path.join(root, scheme + (index ? '-key2' : ''), line)),
      );
    }
    media += line + '\n';
    identity += line + '\n';
  }
  await writeFile(path.join(dir, 'index.m3u8'), media);
  await writeFile(path.join(dir, 'identity.m3u8'), identity);
}
