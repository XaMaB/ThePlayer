import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const fixtures =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const playerRoot = fileURLToPath(new URL('..', import.meta.url));
const requests = [];
let failOnce = true,
  liveAt = 0;
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    requests.push(u.pathname);
    if (u.pathname === '/fixture/discontinuity.m3u8') {
      res.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n' +
          Array.from(
            { length: 6 },
            (_, i) =>
              (i === 3 ? '#EXT-X-DISCONTINUITY\n' : '') +
              '#EXTINF:2,\nts/segment' +
              String(i % 3).padStart(2, '0') +
              '.ts\n',
          ).join('') +
          '#EXT-X-ENDLIST\n',
      );
      return;
    }
    if (u.pathname === '/fixture/event.m3u8') {
      const count = requests.filter((x) => x === u.pathname).length;
      res.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-TARGETDURATION:2\n' +
          Array.from(
            { length: 5 },
            (_, i) =>
              '#EXTINF:2,\nts/segment' + String(i).padStart(2, '0') + '.ts\n',
          ).join('') +
          (count >= 2 ? '#EXT-X-ENDLIST\n' : ''),
      );
      return;
    }
    if (u.pathname === '/fixture/live.m3u8') {
      if (!liveAt) liveAt = Date.now();
      const first = Math.min(3, Math.floor((Date.now() - liveAt) / 2000));
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end(
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' +
          first +
          '\n' +
          Array.from(
            { length: 5 },
            (_, i) =>
              '#EXTINF:2,\nts/segment' +
              String(first + i).padStart(2, '0') +
              '.ts\n',
          ).join(''),
      );
      return;
    }
    if (u.pathname === '/fixture/flaky/segment00.ts' && failOnce) {
      failOnce = false;
      res.writeHead(503);
      res.end();
      return;
    }
    const fixture = u.pathname.startsWith('/fixture/');
    const relative = fixture
      ? u.pathname.slice(9).replace(/^flaky\//, 'ts/')
      : u.pathname === '/'
        ? 'index.html'
        : u.pathname.slice(1);
    const root = fixture ? fixtures : path.join(playerRoot, 'dist');
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep)) throw new Error('Path');
    const data = await readFile(file);
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : file.endsWith('.html')
            ? 'text/html'
            : file.endsWith('.m3u8')
              ? 'application/vnd.apple.mpegurl'
              : file.endsWith('.vtt')
                ? 'text/vtt'
                : 'application/octet-stream',
    );
    if (req.headers.range) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      if (!match) throw new Error('Range');
      const start = Number(match[1]),
        end = Number(match[2]);
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
      });
      res.end(data.subarray(start, end + 1));
    } else res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const [source, transport] of [
    ['renditions.m3u8', 'fetch'],
    ['ts-renditions.m3u8', 'fetch'],
    ['ts/index.m3u8', 'fetch'],
    ['fmp4/index.m3u8', 'xhr'],
    ['encrypted/index.m3u8', 'fetch'],
    ['implicit-iv/index.m3u8', 'fetch'],
    ['bframes/index.m3u8', 'fetch'],
    ['byterange/index.m3u8', 'fetch'],
    ['flaky/index.m3u8', 'fetch'],
    ['master.m3u8', 'fetch'],
    ['live.m3u8', 'fetch'],
    ['event.m3u8', 'fetch'],
    ['discontinuity.m3u8', 'fetch'],
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(
      base +
        '/embed.html?' +
        new URLSearchParams({
          src: base + '/fixture/' + source,
          transport,
          quality: '0',
        }),
    );
    try {
      await page.waitForFunction(
        () =>
          window.player?.diagnostics?.state === 'playing' &&
          document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames > 40,
        null,
        { timeout: 25000 },
      );
      if (source === 'event.m3u8')
        await page.waitForFunction(() => window.player.isLive === false, null, {
          timeout: 10000,
        });
      if (source === 'discontinuity.m3u8')
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 8,
          null,
          { timeout: 15000 },
        );
      const live = source === 'live.m3u8';
      await page.waitForTimeout(600);
      assert.equal(
        await page.locator('#live-button').evaluate((e) => e.hidden),
        !live,
      );
      assert.equal(
        await page.locator('#seek-bar').evaluate((e) => e.hidden),
        live,
      );

      if (source === 'ts-renditions.m3u8') {
        const frames = await page.evaluate(
          () =>
            document.querySelector('video').getVideoPlaybackQuality()
              .totalVideoFrames,
        );
        await page.evaluate(() => window.player.selectQuality(1));
        const boundary = await page.evaluate(
          () => window.player.diagnostics.switches.at(-1).effectiveAt,
        );
        await page.waitForFunction(
          (t) =>
            document.querySelector('video').currentTime > t + 5 &&
            document.querySelector('video').videoWidth === 640,
          boundary,
          { timeout: 20000 },
        );
        assert.ok(
          (await page.evaluate(
            () =>
              document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames,
          )) >
            frames + 100,
        );
        assert.ok(
          (await page.evaluate(() => window.player.diagnostics.buffer.ahead)) <
            16,
        );
      }
      if (source === 'renditions.m3u8') {
        assert.equal(
          await page.evaluate(() => window.player.audioTracks.length),
          2,
        );
        assert.equal(
          await page.evaluate(() => window.player.qualityLevels.length),
          2,
        );
        const mediaSource = await page.evaluate(
          () => document.querySelector('video').src,
        );
        await page.evaluate(async () => {
          const video = document.querySelector('video');
          video.muted = false;
          const context = new AudioContext(),
            analyser = context.createAnalyser();
          analyser.fftSize = 4096;
          context.createMediaElementSource(video).connect(analyser);
          analyser.connect(context.destination);
          await context.resume();
          window.testAudio = { context, analyser };
        });
        const tone = () =>
          page.evaluate(() => {
            const { context, analyser } = window.testAudio,
              bins = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(bins);
            let peak = 1;
            for (let i = 2; i < bins.length; i++)
              if (bins[i] > bins[peak]) peak = i;
            return (peak * context.sampleRate) / analyser.fftSize;
          });
        await page.waitForTimeout(200);
        assert.ok(
          Math.abs((await tone()) - 440) < 30,
          'English track must decode the 440 Hz fixture',
        );
        await page.locator('#screen').hover();
        await page.locator('#audio-toggle').click();
        await page.locator('#audio-menu [data-track="hls-audio-1"]').click();
        await page.waitForFunction(
          () => window.player.selectedAudioTrack === 'hls-audio-1',
          null,
          { timeout: 15000 },
        );
        const audioAt = await page.evaluate(
          () => window.player.diagnostics.switches.at(-1).effectiveAt,
        );
        await page.waitForFunction(
          (t) => document.querySelector('video').currentTime > t + 0.4,
          audioAt,
          { timeout: 12000 },
        );
        assert.ok(
          Math.abs((await tone()) - 880) < 30,
          'Spanish track must decode the 880 Hz fixture',
        );
        assert.equal(
          await page.evaluate(() => document.querySelector('video').src),
          mediaSource,
        );
        await page.locator('#screen').hover();
        await page.locator('#quality-toggle').click();
        await page.locator('#quality-menu [data-track="1"]').click();
        await page.waitForFunction(
          () =>
            window.player.selectedQuality === 1 &&
            document.querySelector('video').videoWidth === 640,
          null,
          { timeout: 15000 },
        );
        assert.equal(
          await page.evaluate(() => document.querySelector('video').src),
          mediaSource,
        );
        assert.ok(
          Math.abs((await tone()) - 880) < 30,
          'Quality change must keep selected audio',
        );
        await page.evaluate(() => document.querySelector('video').pause());
        await page.evaluate(() =>
          window.player.selectAudioTrack('hls-audio-0'),
        );
        assert.equal(
          await page.evaluate(() => document.querySelector('video').paused),
          true,
        );
        await page.evaluate(() => window.player.selectQuality(0));
        assert.equal(
          await page.evaluate(() => document.querySelector('video').paused),
          true,
        );
        await page.evaluate(() => window.player.play());
        const backAt = await page.evaluate(() =>
          Math.max(
            ...window.player.diagnostics.switches
              .slice(-2)
              .map((s) => s.effectiveAt),
          ),
        );
        await page.waitForFunction(
          (t) => document.querySelector('video').currentTime > t + 0.4,
          backAt,
          { timeout: 12000 },
        );
        assert.ok(
          Math.abs((await tone()) - 440) < 30,
          'Switching back must decode the original audio',
        );
        assert.equal(
          await page.evaluate(() => document.querySelector('video').videoWidth),
          320,
        );
        await page.evaluate(() => window.testAudio.context.close());
      }
      if (source === 'fmp4/index.m3u8') {
        await page.evaluate(
          () => (document.querySelector('video').currentTime = 14),
        );
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 15,
          null,
          { timeout: 10000 },
        );
        await page.evaluate(
          () => (document.querySelector('video').currentTime = 1),
        );
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 2 &&
            document.querySelector('video').currentTime < 5,
          null,
          { timeout: 10000 },
        );
      }
      if (source === 'master.m3u8') {
        await page.locator('#screen').hover();
        await page.locator('#cc-toggle').click();
        await page.locator('#cc-menu [data-track="hls-sub-0"]').click();
        await page.waitForFunction(
          () =>
            Array.from(document.querySelector('video').textTracks).some(
              (t) => t.mode === 'showing' && t.activeCues?.length,
            ),
          null,
          { timeout: 8000 },
        );
        assert.ok(
          (await page.evaluate(() => window.__moq.diagnostics.cuesReceived)) >
            0,
        );
        const displayed = await page.evaluate(
          () => window.__moq.diagnostics.cuesRendered,
        );
        await page.evaluate(() => window.player.selectSubtitleTrack(''));
        assert.equal(
          await page.evaluate(() => window.__moq.diagnostics.cuesRendered),
          displayed,
        );
        assert.ok(
          await page.evaluate(() =>
            Array.from(document.querySelector('video').textTracks).every(
              (t) => t.mode === 'disabled',
            ),
          ),
        );
      }
      if (live) {
        const before = await page.evaluate(
          () => document.querySelector('video').currentTime,
        );
        await page.waitForFunction(
          (t) => document.querySelector('video').currentTime > t + 5,
          before,
          { timeout: 15000 },
        );
        assert.ok(
          requests.filter((r) => r === '/fixture/live.m3u8').length > 1,
        );
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(
        await page.evaluate(() => window.__moq.diagnostics.errors),
        [],
      );
      console.log(
        'PASS',
        source,
        transport,
        await page.evaluate(() => ({
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
          diag: window.player.diagnostics,
        })),
      );
      await page.evaluate(() => window.player.destroy());
      const count = requests.length;
      await page.waitForTimeout(500);
      assert.equal(requests.length, count, 'teardown must stop requests');
    } catch (error) {
      console.log(
        'FAIL',
        source,
        await page.evaluate(() => ({
          errors: window.__moq?.diagnostics,
          diag: window.player?.diagnostics,
          video: document.querySelector('video').error?.message,
        })),
      );
      throw error;
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
