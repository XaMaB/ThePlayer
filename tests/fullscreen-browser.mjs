import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { caseDeadline } from './helpers/case-deadline.mjs';
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    const deadline = caseDeadline(`${name} fullscreen`);
    try {
      for (const mode of [
        'native',
        'legacy',
        'presentation',
        'prefixed',
        'unsupported',
        ...(name === 'chromium' ? ['standard'] : []),
      ]) {
        deadline.phase(mode);
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(base + '/harness.html');
        await page.evaluate(async (mode) => {
          const { mountControls } = await import('/player.js');
          window.video = document.querySelector('video');
          window.screenElement = document.createElement('div');
          screenElement.className = 'screen';
          screenElement.style.cssText =
            'position:relative;width:800px;height:450px';
          video.before(screenElement);
          screenElement.append(video);
          const css = document.createElement('link');
          css.rel = 'stylesheet';
          css.href = '/style.css';
          document.head.append(css);
          window.ready = 0;
          window.width = 0;
          window.support = false;
          window.nativeActive = false;
          window.entered = 0;
          window.exited = 0;
          window.denied = false;
          window.failures = [];
          Object.defineProperties(video, {
            readyState: { get: () => ready },
            videoWidth: { get: () => width },
          });
          if (mode !== 'standard')
            Object.defineProperty(screenElement, 'requestFullscreen', {
              value: undefined,
            });
          Object.defineProperties(screenElement, {
            webkitRequestFullscreen: { value: undefined, configurable: true },
            webkitRequestFullScreen: { value: undefined, configurable: true },
          });
          Object.defineProperties(video, {
            webkitEnterFullscreen: { value: undefined, configurable: true },
            webkitEnterFullScreen: { value: undefined, configurable: true },
            webkitExitFullscreen: { value: undefined, configurable: true },
            webkitExitFullScreen: { value: undefined, configurable: true },
            webkitSetPresentationMode: { value: undefined, configurable: true },
            webkitSupportsFullscreen: { get: () => support },
            webkitDisplayingFullscreen: { get: () => nativeActive },
          });
          if (mode === 'native' || mode === 'legacy') {
            Object.defineProperty(
              video,
              mode === 'native'
                ? 'webkitEnterFullscreen'
                : 'webkitEnterFullScreen',
              {
                value: function () {
                  if (this !== video)
                    throw new Error('Wrong fullscreen receiver');
                  if (denied)
                    throw new DOMException(
                      'Fullscreen denied',
                      'NotAllowedError',
                    );
                  entered++;
                  nativeActive = true;
                  video.dispatchEvent(new Event('webkitbeginfullscreen'));
                },
              },
            );
            Object.defineProperty(
              video,
              mode === 'native'
                ? 'webkitExitFullscreen'
                : 'webkitExitFullScreen',
              {
                value: () => {
                  exited++;
                  nativeActive = false;
                  video.dispatchEvent(new Event('webkitendfullscreen'));
                },
              },
            );
          }
          if (mode === 'presentation') {
            Object.defineProperty(video, 'webkitSupportsPresentationMode', {
              value: () => true,
            });
            Object.defineProperty(video, 'webkitPresentationMode', {
              value: 'inline',
              writable: true,
            });
            Object.defineProperty(video, 'webkitSetPresentationMode', {
              value: (value) => {
                video.webkitPresentationMode = value;
                if (value === 'fullscreen') entered++;
                else exited++;
                video.dispatchEvent(new Event('webkitpresentationmodechanged'));
              },
            });
          }
          if (mode === 'prefixed') {
            Object.defineProperty(document, 'webkitFullscreenElement', {
              value: null,
              writable: true,
            });
            Object.defineProperty(document, 'webkitFullscreenEnabled', {
              value: true,
              writable: true,
            });
            Object.defineProperty(screenElement, 'webkitRequestFullscreen', {
              value: () => {
                entered++;
                document.webkitFullscreenElement = screenElement;
                document.dispatchEvent(new Event('webkitfullscreenchange'));
              },
            });
            Object.defineProperty(document, 'webkitExitFullscreen', {
              value: () => {
                exited++;
                document.webkitFullscreenElement = null;
                document.dispatchEvent(new Event('webkitfullscreenchange'));
              },
            });
          }
          window.player = Object.assign(new EventTarget(), {
            isLive: false,
            audioTracks: [],
            subtitleTracks: [],
          });
          window.controls = mountControls(
            screenElement,
            video,
            () => player,
            (error) => failures.push(error),
          );
        }, mode);
        const button = page.locator('#fullscreen');
        if (mode === 'unsupported') {
          assert.equal(await button.isVisible(), false);
        } else {
          if (['native', 'legacy', 'presentation'].includes(mode)) {
            assert.equal(await button.isDisabled(), true);
            await page.locator('.screen').focus();
            await page.keyboard.press('f');
            await page.evaluate(() => controls.fullscreen.toggle());
            assert.equal(await page.evaluate(() => entered), 0);
            await page.evaluate(() => {
              ready = 1;
              video.dispatchEvent(new Event('loadedmetadata'));
            });
            assert.equal(await button.isDisabled(), true);
            await page.evaluate(() => {
              width = 640;
              support = true;
              video.dispatchEvent(new Event('resize'));
            });
            assert.equal(await button.isEnabled(), true);
            assert.equal(
              await page.evaluate(() => entered),
              0,
              'Metadata must not auto-enter fullscreen without a gesture',
            );
          }
          await button.click();
          await page.waitForFunction(() => controls.fullscreen.active);
          assert.equal(await button.getAttribute('aria-pressed'), 'true');
          if (mode === 'standard') {
            const geometry = await page.evaluate(() => ({
              width: screenElement.getBoundingClientRect().width,
              height: screenElement.getBoundingClientRect().height,
              viewportWidth: innerWidth,
              viewportHeight: innerHeight,
            }));
            assert.equal(geometry.width, geometry.viewportWidth);
            assert.equal(geometry.height, geometry.viewportHeight);
          }

          assert.equal(
            await button.getAttribute('aria-label'),
            'Exit fullscreen',
          );
          await button.click();
          await page.waitForFunction(() => !controls.fullscreen.active);
          assert.equal(await button.getAttribute('aria-pressed'), 'false');
          if (mode === 'native') {
            await button.click();
            await page.evaluate(() => {
              nativeActive = false;
              video.dispatchEvent(new Event('webkitendfullscreen'));
            });
            assert.equal(await button.getAttribute('aria-pressed'), 'false');
            await page.evaluate(() => {
              denied = true;
            });
            await button.click();
            await page.waitForFunction(() => failures.length === 1);
            assert.equal(
              await page.evaluate(() => failures.pop()),
              'Fullscreen denied',
            );
            assert.equal(await page.evaluate(() => entered), 2);
            await page.evaluate(() => {
              ready = 0;
              width = 0;
              support = false;
              video.dispatchEvent(new Event('emptied'));
            });
            assert.equal(await button.isDisabled(), true);
          }
          if (mode === 'prefixed') {
            await page.evaluate(() => {
              document.webkitFullscreenEnabled = false;
              document.dispatchEvent(new Event('webkitfullscreenchange'));
            });
            assert.equal(await button.isDisabled(), true);
          }
        }
        assert.deepEqual(errors, []);
        assert.deepEqual(await page.evaluate(() => failures), []);
        await page.evaluate(() => controls.destroy());
        await page.close();
        console.log(
          name,
          mode,
          'fullscreen readiness, enter/exit and cleanup PASS',
        );
      }
    } finally {
      await browser.close();
      deadline.finish();
    }
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
