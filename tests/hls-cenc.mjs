import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const temp = await mkdtemp(path.join(os.tmpdir(), 'theplayer-cenc-'));
try {
  const decode = async (name) => {
    const dir = path.join(root, name),
      list = await readFile(path.join(dir, 'index.m3u8'), 'utf8');
    const files = [
      'init.mp4',
      ...list.split('\n').filter((l) => l.endsWith('.m4s')),
    ];
    const target = path.join(temp, name + '.mp4');
    await writeFile(
      target,
      Buffer.concat(
        await Promise.all(files.map((f) => readFile(path.join(dir, f)))),
      ),
    );
    const hashes = execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        ...(name === 'fmp4'
          ? []
          : [
              '-decryption_key',
              name.endsWith('-key2')
                ? '3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a'
                : '39393939393939393939393939393939',
            ]),
        '-i',
        target,
        '-map',
        '0:v',
        '-map',
        '0:a',
        '-f',
        'framehash',
        '-',
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    return hashes.split('\n').filter((l) => l && !l.startsWith('#'));
  };
  const reference = await decode('fmp4');
  for (const name of [
    'cenc',
    'cbcs',
    'cbcs-constant',
    'cenc-key2',
    'cbcs-key2',
  ]) {
    assert.deepEqual(await decode(name), reference);
    console.log(
      'PASS independent FFmpeg decryption: all video/audio frame hashes and timestamps',
      name,
      reference.length,
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
