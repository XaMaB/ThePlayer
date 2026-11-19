import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundled = await build({
  entryPoints: ['src/engines/dash/telemetry.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
});
const { cmcd } = await import(
  'data:text/javascript;base64,' +
    Buffer.from(bundled.outputFiles[0].text).toString('base64')
);
test('CMCD v1/v2 request syntax, escaping, units and header grouping', () => {
  const object = { type: 'v', duration: 2, bitrate: 250000 },
    metrics = { live: true, buffer: 4.04, throughput: 5250000, startup: true };
  const first = cmcd(
    { version: 1, sessionId: 'session', contentId: 'a"b' },
    object,
    metrics,
  );
  assert.equal(first.headers['CMCD-Object'], 'br=250,d=2000,ot=v');
  assert.equal(first.headers['CMCD-Request'], 'bl=4000,mtp=5300,su');
  assert.equal(
    first.headers['CMCD-Session'],
    'cid="a\\"b",sf=d,sid="session",st=l',
  );
  const second = cmcd({ version: 2 }, object, metrics);
  assert.equal(second.headers['CMCD-Object'], 'br=(250;v),d=2000,ot=v');
  assert.equal(second.headers['CMCD-Request'], 'bl=(4000),mtp=(5300),su');
  assert.equal(second.headers['CMCD-Session'], 'sf=d,st=l,v=2');
  assert.throws(
    () => cmcd({ sessionId: 'secret\nheader' }, object, metrics),
    /printable/,
  );
});
