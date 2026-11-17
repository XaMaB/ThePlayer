import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server, requests } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const external = process.env.HLS_RECOVERY_BASE;
const base = external ?? `http://127.0.0.1:${server.address().port}`;
const runId = Date.now().toString(36);
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr']) {
    if (
      process.env.HLS_RECOVERY_TRANSPORT &&
      process.env.HLS_RECOVERY_TRANSPORT !== transport
    )
      continue;
    for (const scenario of [
      'restart',
      'restart-paused',
      'restart-audio',
      'window-jump',
      'stale-resume',
      'stale-terminal',
      'gap',
      'http-outage',
      'disconnect',
      'timeout',
      'playlist-outage',
      'missing',
      'forbidden',
      'destroy',
    ]) {
      if (
        process.env.HLS_RECOVERY_SCENARIO &&
        process.env.HLS_RECOVERY_SCENARIO !== scenario
      )
        continue;
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base + '/harness.html');
      const route = `/scenario/${runId}-${transport}-${scenario}/${scenario === 'destroy' ? 'missing' : scenario}/`;
      await page.evaluate(
        async ({ url, transport, scenario }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.failures = [];
          window.player.addEventListener('error', (e) =>
            window.failures.push(String(e.detail)),
          );
          try {
            await window.player.load({
              protocol: 'hls',
              url,
              targetBuffer: 4,
              liveStallTimeoutMs: 3000,
              liveRecoveryTimeoutMs:
                scenario === 'stale-terminal' ? 6000 : 30000,
              network: {
                transport,
                timeoutMs: 400,
                retries: 2,
                recoveryWindowMs: scenario === 'missing' ? 2500 : 7000,
              },
            });
          } catch (e) {
            window.failures.push(String(e));
          }
        },
        { url: base + route + 'index.m3u8', transport, scenario },
      );
      if (scenario === 'restart-paused') {
        await page.waitForFunction(
          () => window.player.diagnostics.state === 'playing',
        );
        await page.evaluate(() => document.querySelector('video').pause());
        await page.waitForFunction(
          () =>
            window.player.diagnostics.live.restarts === 1 &&
            document.querySelector('video').readyState >= 2,
        );
        assert.equal(
          await page.evaluate(() => document.querySelector('video').paused),
          true,
        );
        assert.deepEqual(await page.evaluate(() => window.failures), []);
      } else if (
        scenario === 'restart' ||
        scenario === 'window-jump' ||
        scenario === 'restart-audio'
      ) {
        await page
          .waitForFunction(
            () =>
              window.player.diagnostics.live.restarts === 1 &&
              document.querySelector('video').currentTime > 5 &&
              document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames > 30,
            null,
            { timeout: 20000 },
          )
          .catch(async (error) => {
            console.log(
              await page.evaluate(() => ({
                diagnostics: window.player.diagnostics,
                failures: window.failures,
                time: document.querySelector('video').currentTime,
                initial: window.player.engine?.initial,
                ready: document.querySelector('video').readyState,
                ranges: Array.from(
                  { length: document.querySelector('video').buffered.length },
                  (_, i) => [
                    document.querySelector('video').buffered.start(i),
                    document.querySelector('video').buffered.end(i),
                  ],
                ),
                lanes: [
                  window.player.engine?.main,
                  window.player.engine?.audio,
                ].map((l) => ({
                  next: l?.next,
                  offset: l?.offset,
                  ranges: Array.from(
                    { length: l?.buffer?.buffered.length ?? 0 },
                    (_, i) => [
                      l.buffer.buffered.start(i),
                      l.buffer.buffered.end(i),
                    ],
                  ),
                })),
              })),
              [...requests],
            );
            throw error;
          });
        if (scenario === 'restart-audio')
          assert.ok(
            await page.evaluate(
              () =>
                document.querySelector('video').webkitAudioDecodedByteCount > 0,
            ),
          );
        assert.deepEqual(await page.evaluate(() => window.failures), []);
        assert.equal(
          await page.evaluate(() => window.player.diagnostics.state),
          'playing',
        );
      } else if (scenario === 'stale-resume') {
        await page.waitForFunction(
          () => window.player.diagnostics.live.stale,
          null,
          { timeout: 10000 },
        );
        await page.waitForFunction(
          () =>
            !window.player.diagnostics.live.stale &&
            document.querySelector('video').currentTime > 7,
          null,
          { timeout: 15000 },
        );
        assert.deepEqual(await page.evaluate(() => window.failures), []);
      } else if (scenario === 'stale-terminal') {
        await page.waitForFunction(() => window.failures.length, null, {
          timeout: 12000,
        });
        assert.match(
          await page.evaluate(() => window.failures.join()),
          /stopped advancing/,
        );
      } else if (scenario === 'gap') {
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 11,
          null,
          { timeout: 20000 },
        );
        if (!external)
          assert.equal(requests.get(route + 'segment03.ts'), undefined);
        if (!external)
          assert.equal(requests.get(route + 'segment04.ts'), undefined);
        assert.equal(
          await page.evaluate(() => window.player.diagnostics.declaredGaps),
          2,
        );
        assert.deepEqual(await page.evaluate(() => window.failures), []);
      } else if (scenario === 'forbidden') {
        if (!external) assert.equal(requests.get(route + 'index.m3u8'), 1);
        assert.match(await page.evaluate(() => window.failures.join()), /403/);
      } else if (scenario === 'missing') {
        await page.waitForFunction(() => window.failures.length, null, {
          timeout: 15000,
        });
        assert.match(await page.evaluate(() => window.failures.join()), /404/);
        if (!external)
          assert.ok((requests.get(route + 'segment03.ts') ?? 0) <= 5);
      } else if (scenario === 'destroy') {
        await page.waitForFunction(
          () => window.player.diagnostics.recovery.active > 0,
        );
        await page.evaluate(() => window.player.destroy());
        const count = requests.get(route + 'segment03.ts');
        await new Promise((r) => setTimeout(r, 1500));
        if (!external)
          assert.equal(requests.get(route + 'segment03.ts'), count);
        assert.deepEqual(await page.evaluate(() => window.failures), []);
      } else {
        await page
          .waitForFunction(
            (scenario) =>
              (window.player.diagnostics.recovery.recovered > 0 ||
                (scenario === 'disconnect' &&
                  window.player.diagnostics.retries > 0)) &&
              document.querySelector('video').currentTime > 7,
            scenario,
            { timeout: 25000 },
          )
          .catch(async (error) => {
            console.log(
              await page.evaluate(() => ({
                diagnostics: window.player.diagnostics,
                failures: window.failures,
                time: document.querySelector('video').currentTime,
                initial: window.player.engine?.initial,
                ranges: Array.from(
                  { length: document.querySelector('video').buffered.length },
                  (_, i) => [
                    document.querySelector('video').buffered.start(i),
                    document.querySelector('video').buffered.end(i),
                  ],
                ),
              })),
              [...requests],
            );
            throw error;
          });
        assert.deepEqual(await page.evaluate(() => window.failures), []);
        assert.equal(
          await page.evaluate(() => window.player.diagnostics.recovery.active),
          0,
        );
        assert.ok(
          await page.evaluate(
            () =>
              document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames > 30,
          ),
        );
      }
      assert.deepEqual(errors, []);
      await page.evaluate(() => window.player.destroy());
      await page.close();
      console.log('PASS recovery', transport, scenario);
    }
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
