/** Original sample-group rotation fixtures over independently encrypted media. */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root =
  process.env.THEPLAYER_DASH_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-dash-fixtures');
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type), body]);
};
const boxes = (data) => {
  const out = [];
  for (let at = 0; at < data.length; ) {
    const size = data.readUInt32BE(at);
    if (size < 8 || at + size > data.length)
      throw new Error('Invalid fixture box');
    out.push({
      type: data.toString('ascii', at + 4, at + 8),
      body: data.subarray(at + 8, at + size),
    });
    at += size;
  }
  return out;
};
for (const scheme of ['cenc', 'cbcs']) {
  const dir = path.join(root, scheme + '-seig');
  await mkdir(dir, { recursive: true });
  await copyFile(
    path.join(root, scheme, 'init.mp4'),
    path.join(dir, 'init.mp4'),
  );
  for (let n = 0; n < 12; n++) {
    const source = await readFile(
      path.join(
        root,
        scheme + (n % 2 ? '-key2' : ''),
        `segment${String(n).padStart(2, '0')}.m4s`,
      ),
    );
    const kid = Buffer.from(
      n % 2
        ? '0123456789abcdef0123456789abcdee'
        : '0123456789abcdef0123456789abcdef',
      'hex',
    );
    const pssh = box(
      'pssh',
      Buffer.from([1, 0, 0, 0]),
      Buffer.from('1077efecc0b24d02ace33c1e52e2fb4b', 'hex'),
      u32(1),
      kid,
      u32(0),
    );
    const output = boxes(source).map((top) => {
      if (top.type !== 'moof') return box(top.type, top.body);
      const children = boxes(top.body);
      const extras = new Map();
      for (const traf of children.filter((b) => b.type === 'traf')) {
        const count = boxes(traf.body)
          .filter((b) => b.type === 'trun')
          .reduce((n, b) => n + b.body.readUInt32BE(4), 0);
        const sgpd = box(
          'sgpd',
          Buffer.from([1, 0, 0, 0]),
          Buffer.from('seig'),
          u32(20),
          u32(1),
          Buffer.from([0, scheme === 'cbcs' ? 0x19 : 0, 1, 16]),
          kid,
        );
        const sbgp = box(
          'sbgp',
          Buffer.alloc(4),
          Buffer.from('seig'),
          u32(1),
          u32(count),
          u32(0x10001),
        );
        extras.set(traf, Buffer.concat([sgpd, sbgp]));
      }
      const growth =
        pssh.length + [...extras.values()].reduce((n, b) => n + b.length, 0);
      return box(
        'moof',
        pssh,
        ...children.map((child) =>
          child.type !== 'traf'
            ? box(child.type, child.body)
            : box(
                'traf',
                ...boxes(child.body).map((b) => {
                  const body = Buffer.from(b.body);
                  if (b.type === 'trun') {
                    if (!(body[3] & 1))
                      throw new Error('Fixture requires trun data offset');
                    body.writeInt32BE(body.readInt32BE(8) + growth, 8);
                  }
                  return box(b.type, body);
                }),
                extras.get(child),
              ),
        ),
      );
    });
    await writeFile(
      path.join(dir, `segment${String(n).padStart(2, '0')}.m4s`),
      Buffer.concat(output),
    );
  }
}
console.log(
  'Generated CENC/CBCS seig rotation with in-band PSSH and alternating keys',
);
