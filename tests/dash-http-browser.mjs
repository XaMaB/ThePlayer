import { caseDeadline } from './helpers/case-deadline.mjs';
import { chromium, firefox, webkit } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const bundle = await build({
  entryPoints: ['src/engines/dash/network.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'DashHttp',
});
let version = 1;
let partialRequests = 0;
const seen = [];
const server = createServer((req, res) => {
  if (req.url === '/partial') {
    partialRequests++;
    res.write(Buffer.alloc(65536));
    setTimeout(() => res.destroy(), 100);
    return;
  }
  if (req.url === '/') {
    res.end('<!doctype html>');
    return;
  }
  seen.push(req.headers['if-none-match']);
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', `"${version}"`);
  if (req.headers['if-none-match'] === `"${version}"`) {
    res.writeHead(304);
    res.end();
  } else res.end(`manifest-${version}`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const deadline = caseDeadline('DASH conditional HTTP browser suite');
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium' ? { args: ['--no-sandbox'] } : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    version = 1;
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const read = () =>
      page.evaluate(async () => {
        const response = await client.manifest(location.origin + '/manifest');
        return {
          text: new TextDecoder().decode(response.data),
          status: response.status,
          notModified: client.delivery.notModified,
        };
      });
    await page.evaluate((transport) => {
      window.client = new DashHttp.DashResourceClient(
        { transport, retries: 0, recoveryWindowMs: 0 },
        new AbortController().signal,
      );
    }, transport);
    assert.equal((await read()).text, 'manifest-1');
    const cached = await read();
    assert.equal(cached.text, 'manifest-1');
    assert.equal(cached.status, 304);
    assert.equal(cached.notModified, 1);
    version = 2;
    assert.equal((await read()).text, 'manifest-2');
    if (transport === 'fetch') {
      const partial = await page.evaluate(async () => {
        let bytes = 0,
          failed = false;
        try {
          await client.get(
            { url: location.origin + '/partial' },
            {
              retries: 2,
              recoveryWindowMs: 1000,
              onChunk: (data) => {
                bytes += data.length;
              },
            },
          );
        } catch {
          failed = true;
        }
        return { bytes, failed };
      });
      assert.ok(partial.failed && partial.bytes > 0);
      assert.equal(
        partialRequests,
        1,
        'Partially consumed responses are not transparently retried',
      );
    }
    await page.close();
    console.log(
      name,
      transport,
      'ETag 200/304 retention and changed manifest PASS',
    );
  }
  assert.ok(seen.includes('"1"'));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  deadline.finish();
}
