import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const name = process.env.HLS_TEST_BROWSER ?? 'chromium',
  type = { chromium, firefox, webkit }[name];
if (!type) throw Error('Unknown test browser');
const browser = await type.launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const mode of [
      'packed-ac3-48',
      'packed-ac3-44',
      'packed-ac3-32',
      'packed-ac3-surround',
      'packed-ac3-aes128',
      'packed-ac3-sample-aes',
      'ts-ac3',
      'fmp4-ac3',
      'fmp4-eac3',
      'packed-eac3-48',
      'packed-eac3-44',
      'packed-eac3-surround',
      'packed-eac3-sample-aes',
      'ts-eac3',
    ]) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ url, transport }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.metadata = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.player.addEventListener('metadata', (e) =>
              window.metadata.push(e.detail),
            );
            window.loading = window.player
              .load({ protocol: 'hls', url, network: { transport } })
              .catch((e) => window.errors.push(String(e)));
          },
          {
            url: base + '/fixture/' + mode + '/index.m3u8',
            transport,
          },
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 3 ||
            window.errors.length,
          null,
          { timeout: 25000 },
        );
        const supported = await page.evaluate(
          (codec) => MediaSource.isTypeSupported(`audio/mp4;codecs="${codec}"`),
          mode.includes('eac3') ? 'ec-3' : 'ac-3',
        );
        if (!supported) {
          const errors = await page.evaluate(() => window.errors);
          assert.ok(errors.some((e) => /Unsupported browser codec/.test(e)));
          await page.evaluate(() => window.player.destroy());
          console.log(
            'PASS explicit Dolby codec capability rejection',
            name,
            transport,
            mode,
          );
          continue;
        }
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        const first = await page.evaluate(() => ({
          time: document.querySelector('video').currentTime,
          metadata: window.metadata.map((m) => ({
            time: m.time,
            text: m.frames.find((f) => f.id === 'TIT2')?.text,
          })),
        }));
        assert.ok(first.time > 3);
        if (mode.startsWith('packed-'))
          assert.ok(first.metadata.some((m) => m.text === 'AC-3 0'));
        assert.ok(first.metadata.every((m) => m.time >= -0.1 && m.time < 30));
        await page.evaluate(() => {
          const v = document.querySelector('video');
          v.pause();
          v.currentTime = 10;
        });
        await page.waitForFunction(
          () =>
            !document.querySelector('video').seeking &&
            document.querySelector('video').readyState >= 2,
        );
        await page.evaluate(() => {
          document.querySelector('video').currentTime = 1;
        });
        await page.waitForFunction(
          () =>
            !document.querySelector('video').seeking &&
            document.querySelector('video').readyState >= 2,
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        await page.evaluate(() => window.player.destroy());
        console.log('PASS Dolby playback and seeks', name, transport, mode);
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player?.diagnostics,
          })),
        );
        throw error;
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
