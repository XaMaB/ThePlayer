import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';

// Opt-in public interoperability test. Media and public test entitlements are
// fetched from Axinom, never mirrored into the repository or fixture server.
const vectors = [
  ['single', 'Cmaf/protected_1080p_h264_cbcs', 'SingleKey'],
  ['multi', 'MultiKey/Cmaf_h264_1080p_cbcs', 'MultiKey'],
];
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  // The full Chromium distribution includes Widevine on supported hosts;
  // Playwright's default headless shell does not. No ClearKey fallback here.
  browser = await chromium.launch({
    channel: 'chromium',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  for (const [name, directory, keyFile] of vectors) {
    const response = await fetch(
      `https://raw.githubusercontent.com/Axinom/public-test-vectors/master/ContentKeys/Axinom-Encoding-Cmaf-H264-protected-${keyFile}.txt`,
      { signal: AbortSignal.timeout(15000) },
    );
    assert.equal(response.status, 200, 'Public test entitlement document');
    const token = (await response.text()).match(
      /X-AxDRM-Message header:\s*(\S+)/,
    )?.[1];
    assert.ok(token, 'Published public test entitlement');
    for (const transport of ['fetch', 'xhr']) {
      const page = await browser.newPage(),
        pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      let removedPssh = 0;
      if (process.env.DASH_WIDEVINE_MANIFEST_ONLY === '1')
        await page.route('https://media.axprod.net/**/*.mp4', async (route) => {
          const response = await route.fetch({ timeout: 15000 });
          const body = Buffer.from(await response.body());
          const neutralize = (start, end) => {
            for (let p = start; p + 8 <= end; ) {
              const size = body.readUInt32BE(p),
                type = body.toString('ascii', p + 4, p + 8);
              if (size < 8 || p + size > end) break;
              if (type === 'pssh') {
                body.write('free', p + 4);
                removedPssh++;
              } else if (type === 'moov' || type === 'moof')
                neutralize(p + 8, p + size);
              p += size;
            }
          };
          neutralize(0, body.length);
          await route.fulfill({ response, body });
        });
      try {
        await page.goto(
          `http://127.0.0.1:${server.address().port}/harness.html`,
        );
        await page.evaluate(
          async ({ url, token, transport }) => {
            const { ThePlayer } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.errors = [];
            window.licenses = [];
            window.player.addEventListener('error', (event) =>
              window.errors.push(String(event.detail)),
            );
            window.player
              .load({
                protocol: 'dash',
                url,
                network: { transport },
                drm: {
                  keySystem: 'com.widevine.alpha',
                  videoRobustness: 'SW_SECURE_CRYPTO',
                  audioRobustness: 'SW_SECURE_CRYPTO',
                  license: async (message, type, signal) => {
                    const response = await fetch(
                      'https://drm-widevine-licensing.axprod.net/AcquireLicense',
                      {
                        method: 'POST',
                        headers: { 'X-AxDRM-Message': token },
                        body: message,
                        signal,
                      },
                    );
                    window.licenses.push({ type, status: response.status });
                    if (!response.ok)
                      throw new Error(`License HTTP ${response.status}`);
                    return new Uint8Array(await response.arrayBuffer());
                  },
                },
              })
              .catch((error) => window.errors.push(String(error)));
          },
          {
            url: `https://media.axprod.net/TestVectors/${directory}/manifest.mpd`,
            token,
            transport,
          },
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 5 ||
            window.errors.length,
          null,
          { timeout: 45000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        const initial = await page.evaluate(() => ({
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
          audio: document.querySelector('video').webkitAudioDecodedByteCount,
        }));
        assert.ok(initial.frames > 80, 'Widevine decoded video');
        assert.ok(initial.audio > 0, 'Widevine decoded audio');
        await page.evaluate(() => {
          const video = document.querySelector('video');
          video.pause();
          video.currentTime = 45;
        });
        await page.waitForFunction(
          () => {
            const video = document.querySelector('video');
            return (
              !video.seeking && video.readyState >= 2 && video.currentTime >= 45
            );
          },
          null,
          { timeout: 30000 },
        );
        await page.evaluate(async () => {
          await window.player.selectAudioTrack(
            window.player.audioTracks[1].name,
          );
          await window.player.selectQuality(0);
          document.querySelector('video').currentTime = 2;
          return document.querySelector('video').play();
        });
        await page.waitForFunction(
          () => {
            const video = document.querySelector('video');
            return (
              video.currentTime > 6 &&
              video.currentTime < 15 &&
              !video.seeking &&
              video.videoWidth === 512
            );
          },
          null,
          { timeout: 45000 },
        );
        const result = await page.evaluate(() => ({
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
          audio: document.querySelector('video').webkitAudioDecodedByteCount,
          errors: window.errors,
          licenses: window.licenses,
        }));
        assert.deepEqual(result.errors, []);
        assert.deepEqual(pageErrors, []);
        assert.ok(result.frames > initial.frames + 50);
        assert.ok(result.audio > initial.audio);
        assert.ok(result.licenses.length > 0);
        assert.ok(result.licenses.every((r) => r.status === 200));
        if (process.env.DASH_WIDEVINE_MANIFEST_ONLY === '1')
          assert.ok(
            removedPssh > 0,
            'PSSH boxes neutralized without changing media offsets',
          );
        await page.evaluate(() => window.player.destroy());
        assert.equal(
          await page.evaluate(() => document.querySelector('video').mediaKeys),
          null,
        );
        console.log(
          'PASS Widevine CBCS playback, audio/quality switch, seeks and cleanup',
          name,
          transport,
          { frames: result.frames, licenses: result.licenses.length },
        );
      } catch (error) {
        console.error(
          name,
          transport,
          await page.evaluate(() => ({
            errors: window.errors,
            licenses: window.licenses,
            time: document.querySelector('video').currentTime,
            width: document.querySelector('video').videoWidth,
          })),
        );
        throw error;
      } finally {
        await page.unrouteAll({ behavior: 'wait' });
        await page.close();
      }
    }
  }
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
