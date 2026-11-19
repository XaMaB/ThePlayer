import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { dashServer } from './helpers/dash-server.mjs';
const servers = [faultServer().server, dashServer().server];
for (const server of servers)
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: !process.env.DISPLAY,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const deadline = setTimeout(() => process.exit(1), 120000);
try {
  for (const [i, protocol] of ['hls', 'dash'].entries()) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const base = `http://127.0.0.1:${servers[i].address().port}`;
    await page.goto(base + '/harness.html');
    await page.evaluate(
      async ({ protocol, manifest }) => {
        const { ThePlayer, mountControls, SubtitleRenderer } = await import(
          '/player.js'
        );
        const v = document.querySelector('video');
        window.video = v;
        const screen = document.createElement('div');
        screen.className = 'screen';
        screen.id = 'screen';
        v.before(screen);
        screen.append(v);
        const canvas = document.createElement('canvas');
        screen.append(canvas);
        window.canvas = canvas;
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/style.css';
        document.head.append(css);
        screen.style.cssText = 'width:800px;height:450px';
        window.player = new ThePlayer(v);
        window.failures = [];
        window.controls = mountControls(
          screen,
          v,
          () => player,
          (e) => failures.push(e),
          { pictureInPicture: { automatic: true } },
        );
        window.renderer = new SubtitleRenderer(v, canvas);
        renderer.attach(player);
        await player.load({ protocol, url: location.origin + manifest });
        await player.play();
      },
      {
        protocol,
        manifest:
          protocol === 'hls' ? '/fixture/ts/index.m3u8' : '/dash/timeline.mpd',
      },
    );
    await page.waitForFunction(
      () => video.getVideoPlaybackQuality().totalVideoFrames > 10,
    );
    await page.click('#pip-toggle');
    await page.waitForFunction(
      () => controls.pictureInPicture.kind === 'document',
    );
    assert.equal(
      await page.evaluate(() => video.ownerDocument !== document),
      true,
    );
    await page.evaluate(() => {
      video.pause();
      video.dispatchEvent(new CustomEvent('theplayerdocumentchange'));
      player.dispatchEvent(
        new CustomEvent('caption', {
          detail: {
            cue: {
              pts: video.currentTime,
              duration: 10,
              text: 'PiP caption',
              rects: [],
            },
          },
        }),
      );
      video.ownerDocument.getElementById('center-play').click();
    });
    await page.waitForFunction(() => !video.paused);
    // A caption arriving after the opener becomes hidden must still paint in PiP.
    const other = await page.context().newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    // Chromium may keep the opener logically visible while its PiP is visible.
    // Force the opener-only hidden branch to verify renderer ownership explicitly.
    await page.evaluate(() =>
      Object.defineProperty(document, 'hidden', {
        get: () => true,
        configurable: true,
      }),
    );
    await page.evaluate(() =>
      player.dispatchEvent(
        new CustomEvent('caption', {
          detail: {
            cue: {
              pts: video.currentTime,
              duration: 10,
              text: 'Visible in PiP',
              rects: [],
              windows: [
                { rows: ['Visible in PiP'], rowCount: 1, columnCount: 32 },
              ],
            },
          },
        }),
      ),
    );
    await page.waitForFunction(() => renderer.counters.displayed > 0);
    assert.equal(
      await page.evaluate(() =>
        canvas
          .getContext('2d')
          .getImageData(0, 0, canvas.width, canvas.height)
          .data.some((v, i) => i % 4 === 3 && v > 0),
      ),
      true,
    );
    await other.close();
    await page.evaluate(() => delete document.hidden);
    // Controls are still mounted and keyboard listeners now belong to the PiP document.
    await page.evaluate(() => {
      const doc = video.ownerDocument;
      doc.getElementById('screen').focus();
      doc
        .getElementById('screen')
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
        );
    });
    await page.waitForFunction(() => video.paused);
    await page.evaluate(() =>
      video.ownerDocument.getElementById('center-play').click(),
    );
    const before = await page.evaluate(
      () => video.getVideoPlaybackQuality().totalVideoFrames,
    );
    await page.waitForFunction(
      (n) => video.getVideoPlaybackQuality().totalVideoFrames > n + 10,
      before,
    );
    await page.evaluate(() => controls.pictureInPicture.exit());
    assert.equal(
      await page.evaluate(
        () =>
          video.ownerDocument === document &&
          document.querySelectorAll('video').length === 1 &&
          !document.querySelector('.pip-placeholder'),
      ),
      true,
    );
    // Reopen and close using the browser window, then destroy during PiP.
    await page.click('#pip-toggle');
    await page.waitForFunction(
      () => controls.pictureInPicture.kind === 'document',
    );
    await page.evaluate(() => documentPictureInPicture.window.close());
    await page.waitForFunction(() => video.ownerDocument === document);
    await page.click('#pip-toggle');
    await page.waitForFunction(
      () => controls.pictureInPicture.kind === 'document',
    );
    await page.evaluate(() => {
      controls.destroy();
      renderer.destroy();
    });
    await page.waitForFunction(() => video.ownerDocument === document);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => failures), []);
    await page.evaluate(async () => {
      const { mountControls } = await import('/player.js');
      window.controls = mountControls(
        document.getElementById('screen'),
        video,
        () => player,
        (e) => failures.push(e),
        { pictureInPicture: { mode: 'video' } },
      );
    });
    await page.bringToFront();
    await page.click('#pip-toggle');
    await page.waitForFunction(
      () => document.pictureInPictureElement === video,
    );
    await page.evaluate(() => controls.pictureInPicture.exit());
    await page.waitForFunction(() => !document.pictureInPictureElement);
    await page.evaluate(() => controls.destroy());
    console.log(protocol + ': native video PiP passed');
    await page.evaluate(() => player.destroy());
    await context.close();
    console.log(
      protocol +
        ': real Document PiP playback, controls, restoration and teardown passed',
    );
  }
} finally {
  clearTimeout(deadline);
  await browser.close();
  for (const s of servers) await new Promise((r) => s.close(r));
}
