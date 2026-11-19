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
      await page.goto(
        'http://127.0.0.1:' + server.address().port + '/harness.html',
      );
      const result = await page.evaluate(async () => {
        const { NativeRemotePlayback, CastSender, captureFrame } = await import(
          '/player.js'
        );
        const video = document.querySelector('video');
        const remote = new EventTarget();
        let watch,
          resolveWatch,
          cancelled,
          prompts = 0;
        remote.state = 'disconnected';
        remote.watchAvailability = (callback) => {
          watch = callback;
          return new Promise((r) => (resolveWatch = r));
        };
        remote.cancelWatchAvailability = async (id) => (cancelled = id);
        remote.prompt = async () => prompts++;
        Object.defineProperty(video, 'remote', { value: remote });
        const native = new NativeRemotePlayback(video);
        watch(true);
        const supported = native.supported;
        await native.prompt();
        video.disableRemotePlayback = true;
        let blocked = false;
        try {
          await native.prompt();
        } catch {
          blocked = true;
        }
        native.destroy();
        resolveWatch(7);
        await Promise.resolve();
        await Promise.resolve();
        video.disableRemotePlayback = false;
        let received,
          options,
          paused = 0,
          ended = 0,
          removed = 0;
        const context = {
          setOptions: (o) => (options = o),
          addEventListener() {},
          removeEventListener() {
            removed++;
          },
          getCastState: () => 'NOT_CONNECTED',
          requestSession: async () => {},
          getCurrentSession: () => ({ loadMedia: async (r) => (received = r) }),
          endCurrentSession: () => ended++,
        };
        window.cast = {
          framework: {
            CastContext: { getInstance: () => context },
            CastContextEventType: { CAST_STATE_CHANGED: 'cast' },
            RemotePlayer: class {
              isConnected = true;
              isPaused = false;
            },
            RemotePlayerController: class {
              addEventListener() {}
              removeEventListener() {
                removed++;
              }
              playOrPause() {
                paused++;
              }
            },
            RemotePlayerEventType: { ANY_CHANGE: 'any' },
          },
        };
        const api = {
          MediaInfo: class {
            constructor(url, type) {
              this.url = url;
              this.contentType = type;
            }
          },
          LoadRequest: class {
            constructor(media) {
              this.media = media;
            }
          },
          GenericMediaMetadata: class {},
          StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
          DEFAULT_MEDIA_RECEIVER_APP_ID: 'default',
        };
        window.chrome ??= {};
        window.chrome.cast = {
          media: api,
          AutoJoinPolicy: { ORIGIN_SCOPED: 'origin' },
        };
        let localPauses = 0;
        video.pause = () => localPauses++;
        const cast = new CastSender(video, {
          receiverApplicationId: 'test',
          media: () => ({
            url: 'https://example.test/manifest.mpd',
            contentType: 'application/dash+xml',
            title: 'Test',
          }),
        });
        await cast.connect();
        cast.togglePlay();
        cast.disconnect();
        cast.destroy();
        Object.defineProperty(video, 'mediaKeys', { value: {} });
        let drmBlocked = false;
        try {
          await captureFrame(video);
        } catch (error) {
          drmBlocked = error.message.includes('DRM');
        }
        return {
          supported,
          blocked,
          cancelled,
          prompts,
          options,
          received,
          paused,
          ended,
          removed,
          localPauses,
          drmBlocked,
        };
      });
      assert.equal(result.supported, true);
      assert.equal(result.blocked, true);
      assert.equal(result.cancelled, 7);
      assert.equal(result.prompts, 1);
      assert.equal(result.options.receiverApplicationId, 'test');
      assert.equal(result.received.media.contentType, 'application/dash+xml');
      assert.equal(result.received.media.metadata.title, 'Test');
      assert.equal(result.localPauses, 1);
      assert.equal(result.paused, 1);
      assert.equal(result.ended, 1);
      assert.equal(result.removed, 2);
      assert.equal(result.drmBlocked, true);
      console.log(
        name +
          ': simulated native availability/cleanup, Cast SDK request/control lifecycle and DRM capture guard passed',
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
}
