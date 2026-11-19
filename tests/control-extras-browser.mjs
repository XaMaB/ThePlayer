import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { dashServer } from './helpers/dash-server.mjs';
const servers = [faultServer().server, dashServer().server];
for (const s of servers) await new Promise((r) => s.listen(0, '127.0.0.1', r));
const urls = servers.map((s) => 'http://127.0.0.1:' + s.address().port);
try {
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(urls[0] + '/harness.html');
      await page.evaluate(async (urls) => {
        const { ThePlayer, mountControls, PlaybackQueue } = await import(
          '/player.js'
        );
        window.video = document.querySelector('video');
        const screen = document.createElement('div');
        screen.className = 'screen';
        video.before(screen);
        screen.append(video);
        screen.style.cssText = 'width:800px;height:450px';
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/style.css';
        document.head.append(css);
        window.player = new ThePlayer(video);
        window.queue = new PlaybackQueue(
          () => player,
          [
            {
              id: 'hls',
              title: 'HLS test',
              source: {
                protocol: 'hls',
                url: urls[0] + '/fixture/ts/index.m3u8',
              },
              chapters: [
                { title: 'Opening', start: 0 },
                { title: 'Part two', start: 4 },
              ],
            },
            {
              id: 'dash',
              title: 'DASH test',
              source: { protocol: 'dash', url: urls[1] + '/dash/timeline.mpd' },
            },
          ],
        );
        window.failures = [];
        window.controls = mountControls(
          screen,
          video,
          () => player,
          (error) => failures.push(error),
          { extras: { queue, frameCapture: true } },
        );
        await queue.select(0);
      }, urls);
      await page.waitForFunction(
        () => video.getVideoPlaybackQuality().totalVideoFrames > 15,
      );
      await page.click('#info-toggle');
      await page
        .getByLabel('Playback speed', { exact: true })
        .selectOption('1.5');
      assert.equal(await page.evaluate(() => video.playbackRate), 1.5);
      await page.getByText('Chapters', { exact: true }).click();
      await page
        .getByRole('button', { name: '0:04 · Part two', exact: true })
        .click();
      await page.waitForFunction(
        () => video.currentTime >= 4 && !video.seeking && video.readyState >= 2,
      );
      const capture = await page.evaluate(async () => {
        const { captureFrame } = await import('/player.js');
        const blob = await captureFrame(video);
        return {
          type: blob.type,
          magic: Array.from(
            new Uint8Array(await blob.arrayBuffer()).slice(0, 8),
          ),
        };
      });
      assert.equal(capture.type, 'image/png');
      assert.deepEqual(capture.magic, [137, 80, 78, 71, 13, 10, 26, 10]);
      const appearance = await page.evaluate(async () => {
        Object.defineProperty(player, 'subtitleTracks', {
          get: () => [{ name: 'test', format: 'vtt' }],
          configurable: true,
        });
        const track = video.addTextTrack('subtitles', 'Test', 'en');
        track.mode = 'showing';
        const cue = new VTTCue(0, 100, 'Native caption');
        track.addCue(cue);
        window.cue = cue;
        const overlay = document.createElement('div');
        overlay.className = 'theplayer-ttml';
        overlay.innerHTML = '<span>DOM caption</span>';
        video.parentElement.append(overlay);
        window.overlay = overlay;
        controls.extras.captions.set({
          color: 'yellow',
          background: 'dark',
          scale: 1.25,
          offset: -10,
        });
        return {
          color: getComputedStyle(overlay.firstChild).color,
          transform: getComputedStyle(overlay).transform,
        };
      });
      assert.equal(appearance.color, 'rgb(255, 255, 0)');
      assert.notEqual(appearance.transform, 'none');
      await page.waitForFunction(() => cue.line === 80);
      await page.evaluate(() => controls.extras.captions.reset());
      assert.equal(await page.evaluate(() => cue.line), 'auto');
      assert.equal(
        await page.evaluate(() => getComputedStyle(overlay).transform),
        'none',
      );
      await page.evaluate(() => {
        controls.configureLayout({
          toolbar: ['play', 'options', 'pip'],
          center: ['play'],
        });
      });
      assert.equal(await page.locator('#cc-toggle').isVisible(), false);
      assert.equal(await page.locator('#skip-back').isVisible(), false);
      assert.equal(await page.locator('#center-play').isVisible(), true);
      await page.evaluate(() => {
        controls.configureLayout({});
        overlay.remove();
        delete player.subtitleTracks;
      });
      await page.getByText('Playback queue', { exact: true }).click();
      await page
        .getByRole('button', { name: 'DASH test', exact: true })
        .click();
      await page.waitForFunction(
        () =>
          queue.index === 1 &&
          video.getVideoPlaybackQuality().totalVideoFrames > 15,
      );
      assert.equal(await page.evaluate(() => player.protocol), 'dash');
      await page.click('#options-close');
      assert.equal(await page.locator('#player-menu').isVisible(), false);
      await page.evaluate(() => {
        controls.extras.captions.set({ font: 'monospace' });
        controls.destroy();
        queue.destroy();
      });
      assert.equal(await page.locator('[data-caption-preferences]').count(), 0);
      assert.equal(
        await page.locator('video').getAttribute('data-caption-owner'),
        null,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => failures), []);
      await page.evaluate(() => player.destroy());
      console.log(
        name +
          ': real HLS/DASH queue, speed, chapters, PNG capture, caption reset and layout passed',
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  for (const s of servers) await new Promise((r) => s.close(r));
}
