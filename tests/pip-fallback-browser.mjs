import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
try {
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    const browser = await type.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
      // Reproduce metadata arriving before decoded video dimensions.
      const readiness = await page.evaluate(async () => {
        const { mountControls } = await import('/player.js');
        const video = document.createElement('video');
        const screen = document.createElement('div');
        document.body.append(screen);
        screen.append(video);
        let width = 0,
          ready = 0;
        Object.defineProperties(video, {
          videoWidth: { get: () => width },
          readyState: { get: () => ready },
        });
        Object.defineProperty(document, 'pictureInPictureEnabled', {
          value: true,
          configurable: true,
        });
        video.requestPictureInPicture = async () => {};
        const controls = mountControls(
          screen,
          video,
          () => null,
          () => {},
        );
        const button = screen.querySelector('#pip-toggle');
        ready = 1;
        video.dispatchEvent(new Event('loadedmetadata'));
        const before = button.disabled;
        width = 320;
        ready = 2;
        video.dispatchEvent(new Event('resize'));
        const afterResize = !button.disabled;
        const events = ['loadeddata', 'canplay', 'playing', 'play'];
        const recovered = events.every((event) => {
          width = 0;
          video.dispatchEvent(new Event('loadedmetadata'));
          width = 320;
          video.dispatchEvent(new Event(event));
          return !button.disabled;
        });
        width = 0;
        ready = 0;
        video.dispatchEvent(new Event('emptied'));
        const cleared = button.disabled;
        controls.destroy();
        screen.remove();
        return { before, afterResize, recovered, cleared };
      });
      assert.deepEqual(readiness, {
        before: true,
        afterResize: true,
        recovered: true,
        cleared: true,
      });
      const result = await page.evaluate(async () => {
        const { PictureInPictureController } = await import('/player.js');
        const video = document.querySelector('video');
        const screen = document.createElement('div');
        video.before(screen);
        screen.append(video);
        Object.defineProperties(video, {
          readyState: { value: 4 },
          videoWidth: { value: 320 },
          paused: { value: false },
        });
        let active = null,
          standard = 0,
          safari = 0,
          action = null,
          unregistered = 0;
        Object.defineProperty(document, 'pictureInPictureEnabled', {
          value: true,
          configurable: true,
        });
        Object.defineProperty(document, 'pictureInPictureElement', {
          get: () => active,
        });
        video.requestPictureInPicture = async () => {
          standard++;
          active = video;
          video.dispatchEvent(new Event('enterpictureinpicture'));
        };
        document.exitPictureInPicture = async () => {
          active = null;
          video.dispatchEvent(new Event('leavepictureinpicture'));
        };
        Object.defineProperty(window, 'documentPictureInPicture', {
          value: undefined,
          configurable: true,
        });
        Object.defineProperty(navigator, 'mediaSession', {
          value: {
            setActionHandler: (type, fn) => {
              action = fn;
              if (!fn) unregistered++;
            },
          },
          configurable: true,
        });
        const first = new PictureInPictureController(screen, video, {
          automatic: true,
        });
        await first.enter();
        const native = first.kind === 'video';
        await first.exit();
        action();
        await new Promise((r) => setTimeout(r, 0));
        const auto = first.active;
        await first.exit();
        const second = new PictureInPictureController(screen, video, {
          automatic: true,
        });
        first.destroy();
        const preserved = !!action;
        second.destroy();
        const cleaned = action === null;
        Object.defineProperty(document, 'pictureInPictureEnabled', {
          value: false,
          configurable: true,
        });
        video.webkitSupportsPresentationMode = () => true;
        video.webkitSetPresentationMode = (mode) => {
          safari++;
          video.webkitPresentationMode = mode;
        };
        const legacy = new PictureInPictureController(screen, video);
        await legacy.enter();
        const safariActive = legacy.active;
        await legacy.exit();
        legacy.destroy();
        video.webkitSupportsPresentationMode = () => false;
        const unavailable = new PictureInPictureController(screen, video);
        const unsupported = !unavailable.supported;
        unavailable.destroy();
        Object.defineProperty(document, 'pictureInPictureEnabled', {
          value: true,
          configurable: true,
        });
        Object.defineProperty(window, 'documentPictureInPicture', {
          value: {
            requestWindow: async () => {
              throw new DOMException('denied', 'NotAllowedError');
            },
          },
          configurable: true,
        });
        const denied = new PictureInPictureController(screen, video);
        const before = standard;
        let permission;
        try {
          await denied.enter();
        } catch (e) {
          permission = e.name;
        }
        denied.destroy();
        // Only an unsupported document API can fall back; not a permission denial.
        Object.defineProperty(window, 'documentPictureInPicture', {
          value: {
            requestWindow: async () => {
              throw new DOMException('unsupported', 'NotSupportedError');
            },
          },
          configurable: true,
        });
        const fallback = new PictureInPictureController(screen, video);
        await fallback.enter();
        const fellBack = fallback.kind === 'video';
        fallback.destroy();
        Object.defineProperty(navigator, 'mediaSession', {
          value: {
            setActionHandler: () => {
              throw new TypeError('unsupported action');
            },
          },
          configurable: true,
        });
        const noAuto = new PictureInPictureController(screen, video, {
          automatic: true,
        });
        const manualOnly = !noAuto.automaticEnabled;
        noAuto.destroy();
        let finish;
        Object.defineProperty(window, 'documentPictureInPicture', {
          value: { requestWindow: () => new Promise((r) => (finish = r)) },
          configurable: true,
        });
        const pending = new PictureInPictureController(screen, video);
        const open = pending.enter();
        pending.destroy();
        let closed = false;
        finish({ close: () => (closed = true) });
        await open;
        return {
          native,
          auto,
          preserved,
          cleaned,
          safariActive,
          safari,
          unsupported,
          permission,
          standard,
          before,
          fellBack,
          manualOnly,
          closed,
          unregistered,
        };
      });
      for (const key of [
        'native',
        'auto',
        'preserved',
        'cleaned',
        'safariActive',
        'unsupported',
        'fellBack',
        'manualOnly',
        'closed',
      ])
        assert.equal(result[key], true, `${name}: ${key}`);
      assert.equal(result.permission, 'NotAllowedError');
      assert.equal(result.standard, result.before + 1);
      assert.equal(result.safari, 2);
      console.log(
        name +
          ': simulated native/WebKit fallback, permissions, Auto PiP ownership and cancellation passed',
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
}
