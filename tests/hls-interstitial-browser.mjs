import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of (
      process.env.HLS_INTERSTITIAL_SCENARIOS ??
      'pre,mid,list,empty,error,limit,skip,default,negative,snap,nested,live-asset,jump,multiple,post,live'
    ).split(',')) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      if (process.env.HLS_INTERSTITIAL_DEBUG)
        page.on('console', (m) => console.log(m.text()));
      try {
        await page.goto(base + '/harness.html');
        await page.evaluate(
          async ({ url, transport, scenario, debug }) => {
            if (debug) {
              for (const key of ['pause', 'load', 'removeAttribute']) {
                const old = HTMLVideoElement.prototype[key];
                HTMLVideoElement.prototype[key] = function (...args) {
                  console.log(
                    'MEDIA',
                    key,
                    this.currentTime,
                    this.readyState,
                    this.ended,
                    args.join(','),
                  );
                  const r = old.apply(this, args);
                  console.log('MEDIA DONE', key);
                  return r;
                };
              }
              const old = MediaSource.prototype.removeSourceBuffer;
              MediaSource.prototype.removeSourceBuffer = function (...args) {
                console.log('REMOVE BUFFER', this.readyState);
                const r = old.apply(this, args);
                console.log('REMOVE DONE');
                return r;
              };
            }
            const { ThePlayer, mountControls } = await import('/player.js');
            window.player = new ThePlayer(document.querySelector('video'));
            window.events = [];
            window.errors = [];
            window.trace = [];
            if (scenario === 'skip') {
              const video = document.querySelector('video');
              const screen = document.createElement('div');
              screen.className = 'screen';
              video.before(screen);
              screen.append(video);
              window.controls = mountControls(
                screen,
                video,
                () => window.player,
                (message) => window.errors.push(message),
              );
              const css = document.createElement('link');
              css.rel = 'stylesheet';
              css.href = '/style.css';
              document.head.append(css);
            }
            const video = document.querySelector('video');
            for (const type of [
              'loadedmetadata',
              'canplay',
              'playing',
              'waiting',
              'seeking',
              'seeked',
              'pause',
              'ended',
              'error',
            ])
              video.addEventListener(type, () =>
                window.trace.push({
                  type,
                  time: video.currentTime,
                  ready: video.readyState,
                  paused: video.paused,
                }),
              );
            for (const type of [
              'interstitialstart',
              'interstitialasset',
              'interstitialend',
              'interstitialwarning',
              'interstitialprogress',
            ])
              window.player.addEventListener(type, (e) => {
                window.events.push({ type, ...e.detail });
                if (type !== 'interstitialprogress')
                  console.log(type, JSON.stringify(e.detail));
              });
            window.player.addEventListener('error', (e) =>
              window.errors.push(String(e.detail)),
            );
            window.player
              .load({
                protocol: 'hls',
                url,
                network: { transport },
                ...(scenario === 'live' ? { startTime: 2 } : {}),
              })
              .catch((e) => window.errors.push(String(e)));
          },
          {
            url: `${base}/scenario/inter-${transport}-${Date.now().toString(36)}/interstitial-${scenario}/index.m3u8`,
            transport,
            scenario,
            debug: !!process.env.HLS_INTERSTITIAL_DEBUG,
          },
        );
        if (['jump', 'post'].includes(scenario)) {
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 0.3,
          );
          await page.evaluate((kind) => {
            const v = document.querySelector('video');
            v.currentTime = kind === 'post' ? v.duration - 0.5 : 8;
          }, scenario);
        }
        if (scenario === 'skip') {
          await page.waitForFunction(
            () =>
              window.events.some(
                (e) => e.type === 'interstitialprogress' && e.skippable,
              ),
            null,
            { timeout: 20000 },
          );
          const restricted = await page.evaluate(async () => {
            const video = document.querySelector('video');
            video.currentTime = 3;
            video.playbackRate = 2;
            await new Promise((r) => setTimeout(r, 150));
            return { time: video.currentTime, rate: video.playbackRate };
          });
          assert.ok(restricted.time < 2);
          assert.equal(restricted.rate, 1);
          await page
            .locator('#interstitial-skip')
            .waitFor({ state: 'visible' });
          await page.locator('#interstitial-skip').click();
        }
        await page.waitForFunction(
          () =>
            window.events.some((e) => e.type === 'interstitialend') ||
            window.errors.length,
          null,
          { timeout: 30000 },
        );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        if (scenario === 'multiple')
          await page.waitForFunction(
            () =>
              window.events.filter((e) => e.type === 'interstitialend')
                .length === 2,
          );
        const events = await page.evaluate(() => window.events);
        const end = events.findLast((e) => e.type === 'interstitialend');
        assert.ok(end);
        assert.equal(
          events.filter((e) => e.type === 'interstitialstart').length,
          scenario === 'multiple' ? 2 : 1,
        );
        assert.ok(
          Math.abs(
            end.resume -
              ({
                pre: 0,
                negative: 1,
                default: 6,
                jump: 8,
                multiple: 4,
                post: 18,
                live: 12,
              }[scenario] ?? 2),
          ) < 0.15,
        );
        assert.equal(end.cancelled, ['error', 'live-asset'].includes(scenario));
        if (scenario === 'limit') assert.ok(end.played <= 1.01);
        if (scenario === 'skip') assert.equal(end.skipped, true);
        if (['pre', 'mid', 'list'].includes(scenario))
          assert.ok(end.played > 3.8);
        if (scenario !== 'post')
          await page.waitForFunction(
            (resume) =>
              document.querySelector('video').currentTime > resume + 1 &&
              !document.querySelector('video').paused,
            end.resume,
            { timeout: 15000 },
          );
        assert.deepEqual(await page.evaluate(() => window.errors), []);
        if (
          scenario === 'post' &&
          process.env.HLS_INTERSTITIAL_POST_REPLAY !== '0'
        ) {
          await page.evaluate(() => window.player.play());
          await page.waitForFunction(() => {
            const v = document.querySelector('video');
            return v.currentTime > 1 && v.currentTime < 3 && !v.paused;
          });
        }
        await page.evaluate(async () => {
          window.controls?.destroy();
          await window.player.destroy();
        });
        console.log(
          'PASS interstitial playback and primary restoration',
          name,
          transport,
          scenario,
        );
      } catch (error) {
        console.error(
          await page
            .evaluate(() => ({
              events: window.events?.filter(
                (e) => e.type !== 'interstitialprogress',
              ),
              errors: window.errors,
              time: document.querySelector('video').currentTime,
              paused: document.querySelector('video').paused,
              ready: document.querySelector('video').readyState,
              frames: document.querySelector('video').getVideoPlaybackQuality(),
              buffered: Array.from(
                { length: document.querySelector('video').buffered.length },
                (_, i) => [
                  document.querySelector('video').buffered.start(i),
                  document.querySelector('video').buffered.end(i),
                ],
              ),
              trace: window.trace,
              diagnostics: window.player?.diagnostics,
            }))
            .catch(() => ({ diagnosticsUnavailable: true, scenario })),
        );
        throw error;
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
