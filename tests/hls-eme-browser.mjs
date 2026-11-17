import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr'])
    for (const mode of [
      'cenc',
      'cbcs',
      'cbcs-constant',
      'cenc-rotation',
      'cbcs-rotation',
    ])
      for (const licenseMode of mode === 'cenc'
        ? ['keys', 'callback', 'identity', 'missing-key', 'no-drm', 'timeout']
        : ['keys', 'callback', 'identity']) {
        const page = await browser.newPage({ ignoreHTTPSErrors: true }),
          requests = [],
          errors = [];
        page.on('request', (r) => {
          if (r.url().endsWith('.bin'))
            requests.push({ url: r.url(), type: r.resourceType() });
        });
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ url, transport, licenseMode }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            let drm =
              licenseMode === 'keys'
                ? {
                    keySystem: 'org.w3.clearkey',
                    clearKeys: {
                      '0123456789abcdef0123456789abcdef':
                        '39393939393939393939393939393939',
                      '0123456789abcdef0123456789abcdee':
                        '3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a',
                    },
                  }
                : {
                    keySystem: 'org.w3.clearkey',
                    license: async (message, type, signal) => {
                      signal.throwIfAborted();
                      window.licenseCalls = (window.licenseCalls ?? 0) + 1;
                      const request = JSON.parse(
                        new TextDecoder().decode(message),
                      );
                      const k = btoa(
                        String.fromCharCode(...new Uint8Array(16).fill(0x39)),
                      ).replace(/=/g, '');
                      return new TextEncoder().encode(
                        JSON.stringify({
                          keys: request.kids.map((kid) => ({
                            kty: 'oct',
                            kid,
                            k:
                              kid ===
                              btoa(
                                String.fromCharCode(
                                  ...Uint8Array.from(
                                    '0123456789abcdef0123456789abcdee'.match(
                                      /../g,
                                    ),
                                    (x) => parseInt(x, 16),
                                  ),
                                ),
                              )
                                .replace(/\+/g, '-')
                                .replace(/\//g, '_')
                                .replace(/=+$/, '')
                                ? btoa(
                                    String.fromCharCode(
                                      ...new Uint8Array(16).fill(0x3a),
                                    ),
                                  ).replace(/=+$/, '')
                                : k,
                          })),
                          type: 'temporary',
                        }),
                      );
                    },
                  };
            if (licenseMode === 'missing-key')
              drm = {
                keySystem: 'org.w3.clearkey',
                clearKeys: {
                  '00000000000000000000000000000000':
                    '39393939393939393939393939393939',
                },
              };
            if (licenseMode === 'no-drm' || licenseMode === 'identity')
              drm = undefined;
            if (licenseMode === 'timeout')
              drm = {
                keySystem: 'org.w3.clearkey',
                licenseTimeoutMs: 200,
                license: async () => new Promise(() => {}),
              };
            window.loading = window.player
              .load({
                protocol: 'hls',
                url,
                network: { transport },
                drm,
              })
              .catch((e) => window.errors.push(String(e)));
          },
          {
            url:
              base +
              '/fixture/' +
              mode +
              (licenseMode === 'identity' ? '/identity.m3u8' : '/index.m3u8'),
            transport,
            licenseMode,
          },
        );
        try {
          if (['missing-key', 'no-drm', 'timeout'].includes(licenseMode)) {
            await page.waitForFunction(() => window.errors.length > 0, null, {
              timeout: 15000,
            });
            const messages = await page.evaluate(() => window.errors.join(' '));
            assert.match(
              messages,
              licenseMode === 'missing-key'
                ? /No configured Clear Key/
                : licenseMode === 'timeout'
                  ? /timed out/
                  : /DRM configuration|Sample encryption/,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  document.querySelector('video').getVideoPlaybackQuality()
                    .totalVideoFrames,
              ),
              0,
            );
            await page.evaluate(() => window.player.destroy());
            assert.equal(
              await page.evaluate(
                () => document.querySelector('video').mediaKeys,
              ),
              null,
            );
            console.log(
              'PASS EME rejection and cleanup',
              licenseMode,
              transport,
            );
            continue;
          }
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 3,
            null,
            { timeout: 20000 },
          );
          await page.evaluate(() => {
            document.querySelector('video').pause();
            document.querySelector('video').currentTime = 10;
          });
          await page.waitForFunction(
            () =>
              !document.querySelector('video').seeking &&
              document.querySelector('video').readyState >= 2,
          );
          await page.evaluate(
            () => (document.querySelector('video').currentTime = 1),
          );
          await page.waitForFunction(
            () =>
              !document.querySelector('video').seeking &&
              document.querySelector('video').readyState >= 2,
          );
          assert.deepEqual(await page.evaluate(() => window.errors), []);
          assert.deepEqual(errors, []);
          if (licenseMode === 'callback')
            assert.ok(await page.evaluate(() => window.licenseCalls > 0));
          await page.evaluate(() => window.player.destroy());
          assert.equal(
            await page.evaluate(
              () => document.querySelector('video').mediaKeys,
            ),
            null,
          );
          console.log(
            'PASS EME ClearKey playback and seek',
            mode,
            transport,
            licenseMode,
          );
        } catch (error) {
          console.error(
            await page.evaluate(() => ({
              errors: window.errors,
              diagnostics: window.player.diagnostics,
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
