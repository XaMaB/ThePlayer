import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { caseDeadline } from './helpers/case-deadline.mjs';
import { dashServer } from './helpers/dash-server.mjs';
const { server, requests } = dashServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const name = process.env.DASH_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const scenario of (
    process.env.DASH_SCENARIOS ??
    'timeline,number,list,hierarchical,redirect,pto,periods,audio,live,cdn'
  ).split(',')) {
    for (const transport of ['fetch', 'xhr']) {
      const deadline = caseDeadline(`${name} ${transport} ${scenario}`);
      console.log(name, transport, scenario, 'START');
      const page = await browser.newPage();
      const failures = [];
      page.on('pageerror', (e) => failures.push(e.message));
      deadline.phase('navigate');
      await page.goto(base + '/harness.html');
      deadline.phase('initialize player');
      await page.evaluate(
        async ({ scenario, transport }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.errors = [];
          window.player.addEventListener('error', (e) =>
            window.errors.push(String(e.detail)),
          );
          try {
            await window.player.load({
              protocol: 'dash',
              url:
                location.origin +
                (scenario === 'redirect'
                  ? '/redirect.mpd'
                  : `/dash/${scenario}.mpd?session=${transport}`),
              quality: 0,
              targetBuffer: 4,
              audioLanguage: 'eng',
              network: { transport },
            });
          } catch (e) {
            window.errors.push(String(e));
          }
        },
        { scenario, transport },
      );
      try {
        deadline.phase('startup playback');
        await page.waitForFunction(
          () =>
            window.errors.length ||
            (document.querySelector('video').currentTime > 1 &&
              document.querySelector('video').readyState >= 2),
          null,
          { timeout: 15000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        assert.equal(await page.evaluate(() => window.player.protocol), 'dash');
        assert.equal(
          await page.evaluate(() => window.player.isLive),
          scenario === 'live',
        );
        if (scenario === 'audio' && name === 'chromium') {
          await page.evaluate(async () => {
            const video = document.querySelector('video');
            video.muted = false;
            const context = new AudioContext();
            const analyser = context.createAnalyser();
            analyser.fftSize = 4096;
            context.createMediaElementSource(video).connect(analyser);
            analyser.connect(context.destination);
            await context.resume();
            window.audioTest = { context, analyser };
          });
          await expectTone(page, 440);
        }
        if (scenario !== 'audio') {
          assert.equal(
            await page.evaluate(() => window.player.qualityLevels.length),
            2,
          );
          deadline.phase('select quality');
          await page.evaluate(() => window.player.selectQuality(1));
        }
        deadline.phase('select audio');
        await page.evaluate(() =>
          window.player.selectAudioTrack(window.player.audioTracks[1].name),
        );
        assert.equal(
          await page.evaluate(() => window.player.selectedAudioTrack),
          '2',
        );
        deadline.phase('seek and playback progress');
        if (scenario !== 'live') {
          await page.locator('video').evaluate((v) => {
            v.currentTime = 16;
          });
          await page.waitForFunction(
            () =>
              window.errors.length ||
              document.querySelector('video').currentTime > 17,
            null,
            { timeout: 15000 },
          );
          assert.deepEqual(await page.evaluate(() => window.errors), []);
          await page.locator('video').evaluate((v) => {
            v.currentTime = 3;
          });
          await page.waitForFunction(
            () =>
              window.errors.length ||
              document.querySelector('video').currentTime > 4,
            null,
            { timeout: 15000 },
          );
          assert.deepEqual(await page.evaluate(() => window.errors), []);
        } else {
          const start = await page
            .locator('video')
            .evaluate((v) => v.currentTime);
          await page.waitForFunction(
            (t) => document.querySelector('video').currentTime > t + 5,
            start,
            { timeout: 15000 },
          );
          assert.ok(
            await page.evaluate(
              () => window.player.diagnostics.manifestUpdates >= 3,
            ),
          );
        }
        if (scenario === 'audio' && name === 'chromium') {
          await expectTone(page, 880);
          await page.evaluate(() => window.audioTest.context.close());
        }
        if (scenario === 'periods') {
          await page.locator('video').evaluate((v) => {
            v.currentTime = 11;
          });
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 14,
            null,
            { timeout: 15000 },
          );
          await page.locator('video').evaluate((v) => {
            v.currentTime = 22;
          });
          await page.waitForFunction(
            () => document.querySelector('video').ended,
            null,
            { timeout: 15000 },
          );
        }
        if (scenario === 'cdn')
          assert.ok(
            await page.evaluate(
              () => window.player.diagnostics.delivery.switches > 0,
            ),
          );
        deadline.phase('select Auto');
        await page.evaluate(() => window.player.selectQuality(-1));
        assert.equal(
          await page.evaluate(() => window.player.autoQuality),
          true,
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        assert.deepEqual(failures, []);
        deadline.phase('destroy player');
        await page.evaluate(() => window.player.destroy());
        assert.equal(await page.locator('video').getAttribute('src'), null);
      } catch (e) {
        deadline.phase('collect failure diagnostics');
        console.log(
          name,
          transport,
          scenario,
          await page.evaluate(() => ({
            errors: window.errors,
            diagnostics: window.player.diagnostics,
            time: document.querySelector('video').currentTime,
            ready: document.querySelector('video').readyState,
            ranges: Array.from(
              { length: document.querySelector('video').buffered.length },
              (_, i) => [
                document.querySelector('video').buffered.start(i),
                document.querySelector('video').buffered.end(i),
              ],
            ),
          })),
        );
        throw e;
      } finally {
        deadline.phase('cleanup player');
        await page.evaluate(() => window.player.destroy());
        deadline.phase('close page');
        await page.close();
        deadline.finish();
      }
      console.log(name, transport, scenario, 'PASS');
    }
  }
  assert.ok(
    requests.some((url) => url.endsWith('.mp4')),
    'Initialization was fetched',
  );
  assert.ok(
    requests.some(
      (url) => url.endsWith('.m4s') || /indexed-\d+\.mp4$/.test(url),
    ),
    'Media was fetched',
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}

async function expectTone(page, hz) {
  await page.waitForFunction(
    (expected) => {
      const { context, analyser } = window.audioTest;
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      let peak = 1;
      for (let i = 2; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      return (
        bins[peak] > -70 &&
        Math.abs((peak * context.sampleRate) / analyser.fftSize - expected) < 30
      );
    },
    hz,
    { timeout: 5000 },
  );
}
