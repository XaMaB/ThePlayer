import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
import { dashServer } from './helpers/dash-server.mjs';
const servers = [faultServer().server, dashServer().server];
for (const s of servers) await new Promise((r) => s.listen(0, '127.0.0.1', r));
const name = process.env.ABR_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const [idx, protocol] of ['hls', 'dash'].entries()) {
    if (
      process.env.ABR_TEST_PROTOCOLS &&
      !process.env.ABR_TEST_PROTOCOLS.split(',').includes(protocol)
    )
      continue;
    const base = `http://127.0.0.1:${servers[idx].address().port}`;
    const manifest =
      protocol === 'hls' ? '/fixture/renditions.m3u8' : '/dash/timeline.mpd';
    for (const transport of ['fetch', 'xhr'])
      for (const mode of ['highest', 'lowest', 'manual', 'highest-slow'].filter(
        (mode) =>
          !process.env.ABR_TEST_MODES ||
          process.env.ABR_TEST_MODES.split(',').includes(mode),
      )) {
        const page = await browser.newPage();
        const requests = [];
        const pageErrors = [];
        const deadline = setTimeout(() => {
          console.error('ABR policy watchdog', { protocol, transport, mode });
          process.exit(1);
        }, 90000);
        try {
          page.on('pageerror', (e) => pageErrors.push(e.message));
          page.on('request', (r) => requests.push(new URL(r.url()).pathname));
          await page.route(base + manifest, async (route) => {
            const response = await route.fetch();
            let text = await response.text();
            if (protocol === 'hls')
              text +=
                '\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.42c00c,mp4a.40.2",RESOLUTION=320x180,AUDIO="audio"\nvideo-mid/index.m3u8\n';
            else
              text = text.replace(
                /<Representation id="0"[\s\S]*?<\/Representation>/,
                (low) =>
                  low +
                  low
                    .replace('id="0"', 'id="abr-mid"')
                    .replace('bandwidth="250000"', 'bandwidth="450000"')
                    .replaceAll('$RepresentationID$', '0'),
              );
            await route.fulfill({ response, body: text });
          });
          await page.route('**/fixture/video-mid/**', async (route) => {
            const r = await route.fetch({
              url: route.request().url().replace('/video-mid/', '/video-low/'),
            });
            await route.fulfill({ response: r });
          });
          if (mode === 'highest-slow')
            await page.route('**/*.m4s', async (route) => {
              const response = await route.fetch();
              const data = await response.body();
              await new Promise((r) =>
                setTimeout(r, ((data.length * 8) / 250000) * 1000),
              );
              await route.fulfill({ response, body: data });
            });
          await page.goto(base + '/harness.html');
          await page.evaluate(
            async (source) => {
              const { ThePlayer } = await import('/player.js');
              window.player = new ThePlayer(document.querySelector('video'));
              window.errors = [];
              window.changes = [];
              player.addEventListener('error', (e) =>
                errors.push(String(e.detail)),
              );
              player.addEventListener('qualitychange', () =>
                changes.push(player.selectedQuality),
              );
              await player.load(source);
              window.startQuality = player.selectedQuality;
            },
            {
              protocol,
              url: base + manifest,
              quality: mode === 'manual' ? 0 : 'auto',
              targetBuffer: 4,
              network: { transport },
              abr: {
                startup: mode === 'lowest' ? 'lowest' : 'highest',
                upswitch: 'direct',
              },
            },
          );
          assert.equal(
            await page.evaluate(() => player.qualityLevels.length),
            3,
          );
          assert.equal(
            await page.evaluate(() => startQuality),
            mode.startsWith('highest') ? 2 : 0,
          );
          try {
            await page.waitForFunction(
              (mode) =>
                errors.length ||
                (document.querySelector('video').getVideoPlaybackQuality()
                  .totalVideoFrames > 30 &&
                  document.querySelector('video').videoWidth ===
                    (['manual', 'highest-slow'].includes(mode) ? 320 : 640) &&
                  (player.autoQuality
                    ? player.currentQuality ===
                      (mode === 'highest-slow' ? 0 : 2)
                    : player.currentQuality === 0)),
              mode,
              { timeout: 60000 },
            );
          } catch (error) {
            console.error(
              'ABR playback failure',
              { protocol, transport, mode },
              await page.evaluate(() => {
                const v = document.querySelector('video');
                return {
                  diagnostics: player.diagnostics,
                  current: player.currentQuality,
                  selected: player.selectedQuality,
                  changes,
                  errors,
                  time: v.currentTime,
                  paused: v.paused,
                  seeking: v.seeking,
                  ready: v.readyState,
                  mediaError: v.error?.message,
                  buffered: Array.from(
                    { length: v.buffered.length },
                    (_, i) => [v.buffered.start(i), v.buffered.end(i)],
                  ),
                };
              }),
            );
            throw error;
          }
          assert.deepEqual(await page.evaluate(() => errors), []);
          assert.deepEqual(pageErrors, []);
          assert.equal(
            await page.evaluate(() => player.autoQuality),
            mode !== 'manual',
          );
          if (protocol === 'dash' && mode === 'highest-slow')
            assert.ok(
              await page.evaluate(
                () => player.diagnostics.recovery.seekRetries <= 1,
              ),
              'startup seek recovery is bounded',
            );
          if (mode === 'lowest') {
            assert.equal(
              await page.evaluate(() => changes[0]),
              2,
              'first Auto upgrade skips the intermediate profile',
            );
            assert.equal(
              requests.some((p) => p.includes('/video-mid/')),
              false,
            );
          }
          assert.deepEqual(
            await page.evaluate(() => player.diagnostics.quality.abr),
            {
              startup: mode === 'lowest' ? 'lowest' : 'highest',
              upswitch: 'direct',
            },
          );
          const firstVideo = requests.find((p) =>
            protocol === 'hls'
              ? /video-(low|shifted)\/.*\.(mp4|m4s)$/.test(p)
              : /init-[01]\.mp4$/.test(p),
          );
          assert.ok(firstVideo);
          assert.equal(
            protocol === 'hls'
              ? firstVideo.includes('video-shifted')
              : firstVideo.includes('init-1'),
            mode.startsWith('highest'),
          );
          await page.evaluate(() => player.destroy());
          await page.close();
          console.log(
            name,
            protocol,
            transport,
            mode,
            'startup, decoded Auto/manual playback and bandwidth jump PASS',
          );
        } finally {
          await page.close();
          clearTimeout(deadline);
        }
      }
  }
  for (const [idx, protocol] of ['hls', 'dash'].entries()) {
    if (
      process.env.ABR_TEST_PROTOCOLS &&
      !process.env.ABR_TEST_PROTOCOLS.split(',').includes(protocol)
    )
      continue;
    const base = `http://127.0.0.1:${servers[idx].address().port}`;
    const manifest =
      protocol === 'hls' ? '/fixture/renditions.m3u8' : '/dash/timeline.mpd';
    const page = await browser.newPage();
    try {
      await page.goto(
        `http://127.0.0.1:${servers[1].address().port}` +
          '/index.html?' +
          new URLSearchParams({
            src: base + manifest,
            abrStartup: 'highest',
            abrUpswitch: 'direct',
          }),
      );
      await page.waitForFunction(
        () =>
          window.player?.currentQuality === 1 &&
          document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames > 30,
      );
      assert.equal(await page.locator('#abr-startup').inputValue(), 'highest');
      assert.equal(await page.locator('#abr-upswitch').inputValue(), 'direct');
      assert.match(
        await page.locator('#snippet').innerText(),
        /"startup": "highest"/,
      );
      await page.locator('#abr-startup').selectOption('lowest');
      await page.locator('#abr-upswitch').selectOption('stepwise');
      await page.locator('#connect').click();
      await page.waitForFunction(
        () =>
          window.player?.source?.abr?.startup === 'lowest' &&
          window.player?.diagnostics?.state === 'playing',
      );
      assert.deepEqual(await page.evaluate(() => player.source.abr), {
        startup: 'lowest',
        upswitch: 'stepwise',
      });
      assert.match(
        await page.locator('#snippet').innerText(),
        /"upswitch": "stepwise"/,
      );
      await page.locator('#disconnect').click();
      console.log(
        name,
        protocol,
        'demo query parameters, settings and integration snippet PASS',
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}
