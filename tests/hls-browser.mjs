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
    const root = fixture
      ? fixtures
      : (process.env.THEPLAYER_DIST ?? path.join(playerRoot, 'dist'));
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
    ['open-gop/index.m3u8', 'fetch'],
    ['open-gop/index.m3u8', 'xhr'],
    ['pes-split/index.m3u8', 'fetch'],
    ['pes-bundle/index.m3u8', 'xhr'],
    ['pes-bframes/index.m3u8', 'fetch'],
    ['psi/index.m3u8', 'fetch'],
    ['caption-tracks/index.m3u8', 'fetch'],
    ['av1-8/index.m3u8', 'fetch'],
    ['av1-10/index.m3u8', 'xhr'],
    ['av1.m3u8', 'fetch'],
    ['hevc-8/index.m3u8', 'fetch'],
    ['hevc-8/fmp4.m3u8', 'fetch'],
    ['hevc-10/index.m3u8', 'fetch'],
    ['hevc-10/fmp4.m3u8', 'fetch'],
    ['audio-only.m3u8', 'fetch'],
    ['audio-64/index.m3u8', 'fetch'],
    ['audio-64/fmp4.m3u8', 'xhr'],
    ['mixed-media.m3u8', 'fetch'],
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
    if (
      process.env.HLS_FIXTURE_FILTER &&
      !source.includes(process.env.HLS_FIXTURE_FILTER)
    )
      continue;
    const audioOnly = source.startsWith('audio-');
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
      if (
        source.startsWith('hevc-') &&
        !(await page.evaluate(() =>
          MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"'),
        ))
      ) {
        await page.waitForFunction(
          () => window.player?.diagnostics?.state === 'error',
        );
        assert.ok(
          await page.evaluate(() =>
            window.__moq.diagnostics.errors.some((e) =>
              String(e).includes('Unsupported browser codec'),
            ),
          ),
        );
        console.log(
          'CAPABILITY REJECTION',
          source,
          'browser has no HEVC decoder; independent FFmpeg tests verify remux',
        );
        continue;
      }
      await page.waitForFunction(
        (audio) =>
          window.player?.diagnostics?.state === 'playing' &&
          (audio
            ? document.querySelector('video').currentTime > 1
            : document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames > 40),
        audioOnly,
        { timeout: 25000 },
      );
      if (audioOnly || source === 'mixed-media.m3u8') {
        if (!audioOnly) {
          await page.evaluate(() => document.querySelector('video').pause());
          const position = await page.evaluate(
            () => document.querySelector('video').currentTime,
          );
          await page.locator('#quality-toggle').click();
          await page.locator('[data-track="media-audio"]').click();
          await page.waitForFunction(
            () =>
              window.player.mediaMode === 'audio' &&
              document.querySelector('video').readyState >= 2,
          );
          assert.equal(
            await page.evaluate(() => document.querySelector('video').paused),
            true,
          );
          assert.ok(
            Math.abs(
              (await page.evaluate(
                () => document.querySelector('video').currentTime,
              )) - position,
            ) < 0.2,
          );
          await page.evaluate(() => window.player.play());
        }
        await page.waitForFunction(
          () =>
            window.player.catalog.tracks.length === 1 &&
            window.player.catalog.tracks[0].role === 'audio',
        );
        await page.waitForFunction(
          () => !document.querySelector('#audio-only-label').hidden,
        );
        const before = await page.evaluate(
          () => document.querySelector('video').currentTime,
        );
        await page.waitForFunction(
          (t) => document.querySelector('video').currentTime > t + 1,
          before,
        );
        if (source === 'audio-only.m3u8') {
          // Switch a paused, two-second buffer to a four-second-segment ladder.
          // The scheduler must fill the old lane up to the new boundary.
          await page.evaluate(() =>
            window.player.load({
              ...window.player.source,
              quality: 0,
              targetBuffer: 2,
              autoplay: false,
            }),
          );
          await page.waitForFunction(
            () =>
              document.querySelector('video').readyState >= 2 &&
              window.player.catalog.tracks.length === 1,
          );
          await page.evaluate(() => window.player.selectQuality(1));
          assert.equal(
            await page.evaluate(() => window.player.selectedQuality),
            1,
          );
          await page.evaluate(() => window.player.play());
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 5,
          );
          await page.evaluate(() => {
            document.querySelector('video').currentTime = 12;
          });
          await page.waitForFunction(
            () => document.querySelector('video').currentTime > 12.5,
          );
        }
        if (!audioOnly) {
          await page.evaluate(() => window.player.selectMediaMode('video'));
          await page.waitForFunction(
            () =>
              document.querySelector('video').videoWidth === 320 &&
              document.querySelector('video').getVideoPlaybackQuality()
                .totalVideoFrames > 30,
          );
        }
        assert.equal(
          await page.locator('.stats-title .player-version').textContent(),
          'v' +
            JSON.parse(
              await readFile(path.join(playerRoot, 'package.json'), 'utf8'),
            ).version,
        );
      }
      if (source === 'av1.m3u8') {
        await page.evaluate(() => window.player.selectQuality(1));
        await page.waitForFunction(
          () =>
            document.querySelector('video').videoWidth === 320 &&
            window.player.currentQuality === 1,
        );
        await page.evaluate(() => {
          document.querySelector('video').currentTime = 8;
        });
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 9,
        );
        assert.ok(
          await page.evaluate(
            () =>
              document.querySelector('video').webkitAudioDecodedByteCount > 0,
          ),
        );
        assert.match(
          await page.evaluate(
            () =>
              window.player.catalog.tracks.find((t) => t.kind === 'video')
                .codec,
          ),
          /^av01\./,
        );
      }
      if (source === 'caption-tracks/index.m3u8') {
        assert.deepEqual(
          await page.evaluate(
            () => window.player.diagnostics.unsupportedCaptions,
          ),
          [],
        );
        await page.evaluate(() =>
          window.player.selectSubtitleTrack('hls-608-1'),
        );
        await page.waitForFunction(() =>
          Array.from(document.querySelector('video').textTracks).some((t) =>
            Array.from(t.activeCues ?? []).some((c) =>
              c.getCueAsHTML().textContent.includes('ThePlayer'),
            ),
          ),
        );
        const placement = await page.evaluate(() =>
          Array.from(document.querySelector('video').textTracks)
            .flatMap((t) => Array.from(t.activeCues ?? []))
            .map((c) => ({
              line: c.line,
              position: c.position,
              align: c.align,
            })),
        );
        assert.equal(placement[0].line, 10);
        assert.equal(placement[0].position, 30);
        assert.equal(placement[0].align, 'left');
        await page.evaluate(() => {
          document.querySelector('video').currentTime = 12;
        });
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 12.5,
        );
        await page.evaluate(() => window.player.selectSubtitleTrack(''));
        assert.ok(
          await page.evaluate(() =>
            Array.from(document.querySelector('video').textTracks).every(
              (t) => t.mode === 'disabled',
            ),
          ),
        );
        assert.equal(
          await page.locator('#placeholder h2').textContent(),
          'ThePlayer',
        );
      }
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
        const expectTone = async (expected, message) => {
          // A real headless audio sink and Web Audio graph can lag the media
          // element after startup/resume. Require the decoded tone to converge
          // within a bounded interval instead of sampling once after 200 ms.
          const observations = [];
          const deadline = Date.now() + 3000;
          do {
            const hz = await tone();
            observations.push(hz);
            if (Math.abs(hz - expected) < 30) return;
            await page.waitForTimeout(100);
          } while (Date.now() < deadline);
          assert.fail(message + ': ' + JSON.stringify(observations));
        };
        await expectTone(440, 'English track must decode the 440 Hz fixture');
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
        await expectTone(880, 'Spanish track must decode the 880 Hz fixture');
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
        await expectTone(880, 'Quality change must keep selected audio');
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
        await expectTone(440, 'Switching back must decode the original audio');
        assert.equal(
          await page.evaluate(() => document.querySelector('video').videoWidth),
          320,
        );
        await page.evaluate(() => window.testAudio.context.close());
      }
      if (source === 'fmp4/index.m3u8') {
        const duration = await page.evaluate(
          () => document.querySelector('video').duration,
        );
        await page.evaluate(() => {
          const video = document.querySelector('video');
          video.pause();
          video.currentTime = video.duration;
        });
        await page.waitForFunction(
          (end) => {
            const video = document.querySelector('video');
            return (
              !video.seeking &&
              video.buffered.length &&
              video.buffered.end(video.buffered.length - 1) >= end - 0.1
            );
          },
          duration,
          { timeout: 10000 },
        );
        assert.ok(
          (await page.evaluate(
            () => document.querySelector('video').duration,
          )) >=
            duration - 0.1,
          'End seek must not truncate VOD duration to the buffered prefix',
        );
        await page.evaluate(() => {
          document.querySelector('video').currentTime = 14;
          return document.querySelector('video').play();
        });
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
