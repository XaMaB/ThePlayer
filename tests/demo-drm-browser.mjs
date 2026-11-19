import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { dashServer } from './helpers/dash-server.mjs';
const browser = await chromium.launch();
const servers = [];
const keyId = '0123456789abcdef0123456789abcdef';
const key = '39393939393939393939393939393939';
try {
  for (const protocol of ['hls', 'dash']) {
    const { server } = protocol === 'hls' ? faultServer() : dashServer();
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const mode of ['keys', 'license', 'denied']) {
      const page = await browser.newPage();
      const errors = [];
      let calls = 0;
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/api/directory', (route) =>
        route.fulfill({ json: { channels: [] } }),
      );
      await page.route('**/license', async (route) => {
        calls++;
        assert.equal(route.request().method(), 'POST');
        assert.equal(
          route.request().headers()['authorization'],
          'Bearer demo-test',
        );
        if (mode === 'denied')
          return route.fulfill({ status: 403, body: 'provider detail' });
        const challenge = route.request().postDataJSON();
        await route.fulfill({
          json: {
            keys: challenge.kids.map((kid) => ({
              kty: 'oct',
              kid,
              k: Buffer.from(key, 'hex').toString('base64url'),
            })),
            type: 'temporary',
          },
        });
      });
      await page.route('**/index.html', async (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: await readFile(
            (process.env.THEPLAYER_DIST ||
              new URL('../dist/', import.meta.url).pathname) + '/index.html',
          ),
        }),
      );
      await page.goto(base + '/index.html');
      await page.selectOption('#source-protocol', protocol);
      await page.fill(
        '#hls-url',
        base +
          (protocol === 'hls' ? '/fixture/cenc/index.m3u8' : '/dash/cenc.mpd'),
      );
      await page.locator('.drm-panel > summary').click();
      await page.selectOption('#drm-system', 'org.w3.clearkey');
      if (mode === 'keys')
        await page.fill('#drm-keys', JSON.stringify({ [keyId]: key }));
      else {
        await page.fill('#drm-url', base + '/license');
        await page.fill('#drm-headers', '{"Authorization":"Bearer demo-test"}');
      }
      await page.click('#connect');
      if (mode === 'denied') {
        await page.waitForFunction(() =>
          document
            .querySelector('#player-message')
            .textContent.includes('HTTP 403'),
        );
        assert.ok(calls > 0);
      } else {
        await page.waitForFunction(
          () =>
            document.querySelector('video').getVideoPlaybackQuality()
              .totalVideoFrames > 30,
          null,
          { timeout: 20000 },
        );
        assert.equal(calls > 0, mode === 'license');
      }
      const snippet = await page.locator('#snippet').textContent();
      assert.ok(!snippet.includes('Bearer demo-test'));
      assert.ok(!snippet.includes(key));
      assert.ok(snippet.includes('source.drm'));
      await page.click('#disconnect');
      await page.selectOption('#drm-system', '');
      assert.equal(await page.locator('#drm-options').isVisible(), false);
      await page.selectOption('#source-protocol', 'moq');
      assert.equal(await page.locator('#drm-timeout').isDisabled(), true);
      assert.deepEqual(errors, []);
      console.log(`${protocol}: demo DRM ${mode} passed`);
      await page.close();
    }
  }
} finally {
  await browser.close();
  for (const server of servers) await new Promise((r) => server.close(r));
}
