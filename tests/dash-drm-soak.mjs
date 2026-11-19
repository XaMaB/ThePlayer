import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { dashServer } from './helpers/dash-server.mjs';
const seconds = Number(process.env.DASH_SOAK_SECONDS ?? 180);
if (!Number.isFinite(seconds) || seconds < 30)
  throw new Error('Invalid soak duration');
const { server } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.evaluate(async () => {
    const { ThePlayer } = await import('/player.js');
    window.player = new ThePlayer(document.querySelector('video'));
    window.errors = [];
    window.licenses = 0;
    player.addEventListener('error', (e) => errors.push(e.detail.message));
    await player.load({
      protocol: 'dash',
      url: location.origin + '/dash/cenc-seig.mpd',
      targetBuffer: 4,
      drm: {
        keySystem: 'org.w3.clearkey',
        license: async (message) => {
          licenses++;
          const request = JSON.parse(new TextDecoder().decode(message));
          const keys = request.kids.map((kid) => {
            const hex = Array.from(
              atob(kid.replace(/-/g, '+').replace(/_/g, '/')),
              (c) => c.charCodeAt(0).toString(16).padStart(2, '0'),
            ).join('');
            const value = hex.endsWith('ee') ? 0x3a : 0x39;
            return {
              kty: 'oct',
              kid,
              k: btoa(
                String.fromCharCode(...new Uint8Array(16).fill(value)),
              ).replace(/=/g, ''),
            };
          });
          return new TextEncoder().encode(
            JSON.stringify({ type: 'temporary', keys }),
          );
        },
      },
    });
  });
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 1,
  );
  const started = Date.now();
  let frames = 0,
    iterations = 0;
  while (Date.now() - started < seconds * 1000) {
    const target = iterations % 2 ? 2 : 13;
    await page.locator('video').evaluate((v, t) => {
      v.currentTime = t;
      void v.play();
    }, target);
    await page.waitForFunction(
      (t) => document.querySelector('video').currentTime > t + 2,
      target,
      { timeout: 15000 },
    );
    const sample = await page.evaluate(() => ({
      frames: document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames,
      errors,
      licenses,
    }));
    assert.deepEqual(sample.errors, []);
    assert.ok(sample.frames > frames + 20);
    assert.ok(sample.licenses <= 4, 'Repeated KIDs reuse sessions');
    frames = sample.frames;
    iterations++;
    if (iterations % 20 === 0)
      console.log(
        'DASH DRM rotation soak progress',
        Math.round((Date.now() - started) / 1000),
        sample,
      );
  }
  const licenses = await page.evaluate(() => window.licenses);
  assert.ok(licenses >= 2);
  await page.evaluate(() => player.destroy());
  assert.equal(await page.locator('video').evaluate((v) => v.mediaKeys), null);
  console.log('DASH DRM rotation soak PASS', {
    seconds: (Date.now() - started) / 1000,
    frames,
    iterations,
    licenses,
  });
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
