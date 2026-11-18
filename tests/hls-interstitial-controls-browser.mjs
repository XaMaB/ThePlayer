import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      await page.evaluate(async (transport) => {
        const { ThePlayer, mountControls } = await import('/player.js');
        const video = document.querySelector('video'),
          screen = document.createElement('div');
        screen.className = 'screen';
        screen.style.width = '900px';
        video.before(screen);
        screen.append(video);
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/style.css';
        document.head.append(css);
        window.player = new ThePlayer(video);
        window.errors = [];
        window.restored = false;
        window.player.addEventListener('error', (e) =>
          window.errors.push(String(e.detail)),
        );
        window.player.addEventListener('interstitialwarning', (e) =>
          window.errors.push(String(e.detail?.message)),
        );
        window.player.addEventListener(
          'interstitialend',
          () => (window.restored = true),
        );
        window.controls = mountControls(
          screen,
          video,
          () => window.player,
          (e) => window.errors.push(e),
        );
        window.player
          .load({
            protocol: 'hls',
            url:
              location.origin +
              '/scenario/controls-' +
              transport +
              '/interstitial-controls/index.m3u8',
            network: { transport },
            targetBuffer: 4,
          })
          .catch((e) => window.errors.push(String(e)));
      }, transport);
      await page.waitForFunction(
        () =>
          window.errors.length ||
          (window.player.diagnostics?.interstitial?.active &&
            window.player.qualityLevels.length === 2 &&
            document.querySelector('video').currentTime > 0.25 &&
            document.querySelector('video').currentTime < 2),
        null,
        { timeout: 20000 },
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.evaluate(() => document.querySelector('video').pause());
      await page.locator('#cc-toggle').click();
      const subtitle = await page.evaluate(
        () => window.player.subtitleTracks[0].name,
      );
      await page.locator(`#cc-menu button[data-track="${subtitle}"]`).click();
      await page.waitForFunction(
        (name) => window.player.selectedSubtitleTrack === name,
        subtitle,
      );
      await page.locator('#audio-toggle').click();
      await page
        .locator('#audio-menu button[data-track="hls-audio-1"]')
        .click();
      await page.waitForFunction(
        () => window.player.selectedAudioTrack === 'hls-audio-1',
      );
      await page.locator('#quality-toggle').click();
      await page.locator('#quality-menu button[data-track="1"]').click();
      await page.waitForFunction(() => window.player.selectedQuality === 1);
      await page.evaluate(() => {
        document.querySelector('video').currentTime = 6.25;
      });
      await page.waitForFunction(
        () => {
          const v = document.querySelector('video');
          return (
            !v.seeking &&
            v.readyState >= 2 &&
            v.videoWidth === 640 &&
            Array.from(v.textTracks).some(
              (t) => t.mode === 'showing' && t.activeCues?.length,
            )
          );
        },
        null,
        { timeout: 15000 },
      );
      assert.deepEqual(await page.evaluate(() => window.errors), []);
      await page.locator('#interstitial-skip').click();
      await page.waitForFunction(() => window.restored, null, {
        timeout: 20000,
      });
      const restored = await page.evaluate(() => ({
        audio: window.player.audioTracks.length,
        subtitles: window.player.subtitleTracks.length,
        selected: window.player.selectedSubtitleTrack,
        qualities: window.player.qualityLevels.length,
        errors: window.errors,
      }));
      assert.deepEqual(restored, {
        audio: 0,
        subtitles: 0,
        selected: '',
        qualities: 0,
        errors: [],
      });
      await page.evaluate(() => {
        window.controls.destroy();
        return window.player.destroy();
      });
      console.log(
        'PASS standalone asset audio/quality/CC controls and primary selection restoration',
        name,
        transport,
      );
    } catch (error) {
      console.error(
        await page.evaluate(() => ({
          errors: window.errors,
          diag: window.player.diagnostics,
          audio: window.player.selectedAudioTrack,
          subtitle: window.player.selectedSubtitleTrack,
          quality: window.player.selectedQuality,
          time: document.querySelector('video').currentTime,
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
  await new Promise((resolve) => server.close(resolve));
}
