import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { caseDeadline } from './helpers/case-deadline.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    const deadline = caseDeadline(`${name} buffering and seek wave`);
    const browser = await type.launch();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/fixture/ts/segment*.ts', async (route) => {
        const segment = Number(
          /segment(\d+)\.ts/.exec(route.request().url())[1],
        );
        if (segment >= 2) await gate;
        await route.continue();
      });
      await page.goto(base + '/harness.html');
      await page.evaluate(async () => {
        const { ThePlayer, mountControls } = await import('/player.js');
        window.video = document.querySelector('video');
        window.screenElement = document.createElement('div');
        screenElement.className = 'screen';
        screenElement.style.cssText = 'width:800px;height:450px';
        video.before(screenElement);
        screenElement.append(video);
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = '/style.css';
        document.head.append(css);
        window.player = new ThePlayer(video);
        window.failures = [];
        window.controls = mountControls(
          screenElement,
          video,
          () => player,
          (e) => failures.push(e),
          {
            buffering: { labelDelayMs: 600 },
          },
        );
        await player.load({
          protocol: 'hls',
          url: location.origin + '/fixture/ts/index.m3u8',
          targetBuffer: 2,
        });
      });
      deadline.phase('real network starvation');
      await page.waitForFunction(() => video.currentTime > 0.5);
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'true',
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('.theplayer-buffering')
            .classList.contains('has-label'),
        null,
        { timeout: 15000 },
      );
      assert.equal(
        await page.locator('.buffering-label').textContent(),
        'Buffering…',
      );
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'false',
      );
      assert.equal(
        await page
          .locator('.theplayer-buffering')
          .evaluate((el) => getComputedStyle(el).pointerEvents),
        'none',
      );
      if (process.env.BUFFERING_SCREENSHOT)
        await page.screenshot({ path: `/tmp/theplayer-buffering-${name}.png` });
      await page.evaluate(() => video.pause());
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'true',
      );
      await page.evaluate(() => {
        void video.play();
      });
      await page.waitForFunction(() =>
        document
          .querySelector('.theplayer-buffering')
          .classList.contains('is-visible'),
      );
      release();
      deadline.phase('recovery');
      await page.waitForFunction(
        () =>
          video.currentTime > 5 &&
          document
            .querySelector('.theplayer-buffering')
            .getAttribute('aria-hidden') === 'true',
      );
      await page.evaluate(() => video.pause());
      deadline.phase('keyboard and pointer seek waves');
      await page.locator('.screen').focus();
      await page.keyboard.press('ArrowRight');
      assert.ok(
        await page
          .locator('#skip-forward .skip-face')
          .evaluate((el) => el.getAnimations().length > 0),
      );
      await page.keyboard.press('ArrowLeft');
      assert.ok(
        await page
          .locator('#skip-back .skip-face')
          .evaluate((el) => el.getAnimations().length > 0),
      );
      assert.equal(
        await page
          .locator('#skip-forward .skip-face')
          .evaluate((el) => el.getAnimations().length),
        0,
      );
      await page.click('#skip-forward');
      assert.ok(
        await page
          .locator('#skip-forward .skip-trail')
          .evaluate((el) => el.getAnimations().length > 0),
      );
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.keyboard.press('ArrowLeft');
      assert.equal(
        await page
          .locator('#skip-back .skip-face')
          .evaluate((el) => el.getAnimations().length),
        0,
      );
      deadline.phase('configuration and teardown');
      await page.evaluate(async () => {
        controls.destroy();
        const { mountControls } = await import('/player.js');
        window.controls = mountControls(
          screenElement,
          video,
          () => player,
          () => {},
          { buffering: false, seekAnimation: false },
        );
      });
      assert.equal(await page.locator('.theplayer-buffering').count(), 0);
      await page.evaluate(async () => {
        controls.destroy();
        await player.destroy();
      });
      // Deterministic event-policy checks supplement the real network test above.
      await page.evaluate(async () => {
        const { mountControls } = await import('/player.js');
        window.mockReady = 2;
        window.mockPaused = false;
        Object.defineProperty(video, 'readyState', {
          get: () => mockReady,
          configurable: true,
        });
        Object.defineProperty(video, 'paused', {
          get: () => mockPaused,
          configurable: true,
        });
        Object.defineProperty(player, 'protocol', {
          value: 'moq',
          configurable: true,
        });
        window.controls = mountControls(
          screenElement,
          video,
          () => player,
          () => {},
          {
            extras: false,
            pictureInPicture: false,
            buffering: {
              position: 'top',
              color: '#aabbcc',
              delayMs: 100,
              labelDelayMs: 200,
              label: 'Waiting for media',
            },
          },
        );
        video.dispatchEvent(new Event('waiting'));
        mockReady = 4;
        video.dispatchEvent(new Event('canplay'));
      });
      await page.waitForTimeout(250);
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'true',
      );
      assert.equal(
        await page
          .locator('.theplayer-buffering')
          .getAttribute('data-position'),
        'top',
      );
      assert.equal(
        await page
          .locator('.theplayer-buffering')
          .evaluate((el) => el.style.getPropertyValue('--buffering-color')),
        '#aabbcc',
      );
      await page.evaluate(() => {
        mockPaused = true;
        player.dispatchEvent(
          new CustomEvent('statechange', { detail: 'buffering' }),
        );
        video.dispatchEvent(new Event('pause'));
      });
      await page.waitForFunction(
        () =>
          document.querySelector('.buffering-label').textContent ===
          'Waiting for media',
      );
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'false',
      );
      assert.equal(
        await page
          .locator('.buffering-marks path')
          .first()
          .evaluate((el) => getComputedStyle(el).animationName),
        'none',
      );
      await page.evaluate(() =>
        player.dispatchEvent(
          new CustomEvent('statechange', { detail: 'playing' }),
        ),
      );
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'true',
      );
      await page.evaluate(() => {
        player.dispatchEvent(
          new CustomEvent('statechange', { detail: 'buffering' }),
        );
        video.dispatchEvent(new Event('emptied'));
      });
      await page.waitForTimeout(250);
      assert.equal(
        await page.locator('.theplayer-buffering').getAttribute('aria-hidden'),
        'true',
      );
      await page.evaluate(() => {
        player.dispatchEvent(
          new CustomEvent('statechange', { detail: 'buffering' }),
        );
        controls.destroy();
      });
      await page.waitForTimeout(250);
      assert.equal(await page.locator('.theplayer-buffering').count(), 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(await page.evaluate(() => failures), []);
      console.log(
        name,
        'network starvation, pause/resume/recovery, seek waves, reduced motion, configuration and cleanup PASS',
      );
    } finally {
      release();
      await browser.close();
      deadline.finish();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
