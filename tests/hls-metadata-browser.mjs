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
  for (
    let repeat = 0;
    repeat < Number(process.env.HLS_METADATA_REPEATS ?? 1);
    repeat++
  )
    for (const transport of process.env.HLS_METADATA_TRANSPORTS?.split(',') ?? [
      'fetch',
      'xhr',
    ])
      for (const mode of process.env.HLS_METADATA_MODES?.split(',') ?? [
        'ts',
        'ts-malformed',
        'emsg',
        'emsg-v0',
        'emsg-malformed',
      ]) {
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        try {
          await page.goto(base + '/harness.html');
          await page.evaluate(
            async ({ url, transport }) => {
              const { ThePlayer } = await import('/player.js');
              window.player = new ThePlayer(document.querySelector('video'));
              window.errors = [];
              window.trace = [];
              const video = document.querySelector('video');
              for (const type of [
                'loadstart',
                'loadedmetadata',
                'loadeddata',
                'canplay',
                'play',
                'playing',
                'pause',
                'waiting',
                'seeking',
                'seeked',
                'error',
              ])
                video.addEventListener(type, () =>
                  window.trace.push({
                    type,
                    time: video.currentTime,
                    paused: video.paused,
                    ready: video.readyState,
                  }),
                );
              window.player.addEventListener('autoplayblocked', () =>
                window.trace.push({ type: 'autoplayblocked' }),
              );
              window.metadata = [];
              window.warnings = [];
              window.player.addEventListener('metadatawarning', (e) =>
                window.warnings.push(e.detail),
              );
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
              url: base + '/fixture/metadata-' + mode + '/index.m3u8',
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
          assert.deepEqual(await page.evaluate(() => window.errors), []);
          const first = await page.evaluate(() => ({
            time: document.querySelector('video').currentTime,
            metadata: window.metadata.map((m) => ({
              time: m.time,
              text: m.frames.find((f) => f.id === 'TIT2')?.text,
            })),
          }));
          assert.ok(first.time > 3);
          if (mode.endsWith('malformed'))
            assert.ok(await page.evaluate(() => window.warnings.length > 0));
          else {
            assert.ok(first.metadata.length > 0);
            if (mode !== 'emsg-v0')
              assert.ok(first.metadata.some((m) => m.text === 'Metadata 0'));
            assert.ok(
              first.metadata.every((m) => m.time >= -0.1 && m.time < 30),
            );
            assert.deepEqual(await page.evaluate(() => window.warnings), []);
          }
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
          console.log(
            'PASS timed metadata playback, parsing and seeks',
            name,
            transport,
            mode,
          );
        } catch (error) {
          console.error(
            await page.evaluate(() => ({
              errors: window.errors,
              diagnostics: window.player?.diagnostics,
              trace: window.trace,
              media: {
                time: document.querySelector('video').currentTime,
                paused: document.querySelector('video').paused,
                ready: document.querySelector('video').readyState,
                error: document.querySelector('video').error?.message,
              },
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
