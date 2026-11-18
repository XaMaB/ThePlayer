// Optional network-dependent smoke test; deterministic fixtures remain the CI gate.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hlsExamples } from '../demo/hls-examples.mjs';
const root =
  process.env.THEPLAYER_DIST ??
  fileURLToPath(new URL('../dist/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'),
      file = path.resolve(root, url.pathname.slice(1) || 'index.html');
    if (!file.startsWith(root)) throw new Error('Path');
    const data = await readFile(file);
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.css')
          ? 'text/css'
          : 'text/html',
    );
    res.end(data);
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
const results = [];
try {
  for (const source of hlsExamples.filter(
    (s) =>
      !process.env.HLS_PUBLIC_SOURCE || s.id === process.env.HLS_PUBLIC_SOURCE,
  )) {
    const page = await browser.newPage();
    const errors = [],
      failed = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) =>
      failed.push({ url: r.url(), error: r.failure()?.errorText }),
    );
    try {
      await page.goto(
        base +
          '/embed.html?' +
          new URLSearchParams({ src: source.url, quality: '0' }),
      );
      await page.waitForFunction(
        () =>
          window.player?.diagnostics?.state === 'playing' &&
          document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames > 60,
        null,
        { timeout: 60000 },
      );
      const before = await page.evaluate(
        () => document.querySelector('video').currentTime,
      );
      await page.waitForFunction(
        (t) => document.querySelector('video').currentTime > t + 5,
        before,
        { timeout: 20000 },
      );
      const levels = await page.evaluate(() => window.player.qualityLevels);
      if (levels.length > 1) {
        await page.evaluate(() =>
          Promise.race([
            window.player.selectQuality(1),
            new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error('Quality switch timed out')),
                20000,
              ),
            ),
          ]),
        );
        const boundary = await page.evaluate(
          () => window.player.diagnostics.switches.at(-1).effectiveAt,
        );
        await page.waitForFunction(
          (t) => document.querySelector('video').currentTime > t + 0.5,
          boundary,
          { timeout: 20000 },
        );
      }
      const framesBefore = await page.evaluate(
        () =>
          document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
      );
      const continued = await page.evaluate(
        () => document.querySelector('video').currentTime,
      );
      await page.waitForFunction(
        (t) => document.querySelector('video').currentTime > t + 12,
        continued,
        { timeout: 30000 },
      );
      assert.ok(
        await page.evaluate(() => window.player.diagnostics.buffer.ahead < 30),
        'Buffer must stay bounded after quality switch',
      );
      assert.ok(
        (await page.evaluate(
          () =>
            document.querySelector('video').getVideoPlaybackQuality()
              .totalVideoFrames,
        )) >
          framesBefore + 100,
        'Frames must continue rendering after switch',
      );
      if (source.id === 'mux-bbb' || source.id === 'unified-tos') {
        assert.equal(
          levels.filter((v) => /avc[13]\./.test(v.codecs)).length,
          5,
          'All five supported AVC profiles must be available',
        );
        for (const index of [...levels.slice(2).map((v) => v.id), 0]) {
          const beforeAudio = await page.evaluate(
            () => document.querySelector('video').webkitAudioDecodedByteCount,
          );
          await page.evaluate((i) => window.player.selectQuality(i), index);
          const boundary = await page.evaluate(
            () => window.player.diagnostics.switches.at(-1).effectiveAt,
          );
          const width = Number(levels[index].resolution.split('x')[0]);
          await page.waitForFunction(
            ({ boundary, width }) =>
              document.querySelector('video').currentTime > boundary + 1 &&
              document.querySelector('video').videoWidth === width,
            { boundary, width },
            { timeout: 30000 },
          );
          assert.ok(
            (await page.evaluate(
              () => document.querySelector('video').webkitAudioDecodedByteCount,
            )) > beforeAudio,
            'Audio decoding must continue across AAC profiles',
          );
        }
      }
      if (source.id === 'unified-tos') {
        await page.evaluate(() => window.player.selectMediaMode('audio'));
        await page.waitForFunction(
          () =>
            window.player.catalog.tracks.length === 1 &&
            window.player.catalog.tracks[0].role === 'audio',
        );
        assert.equal(
          await page.evaluate(() => window.player.qualityLevels.length),
          2,
        );
        await page.evaluate(() => window.player.selectQuality(1));
        const boundary = await page.evaluate(
          () =>
            window.player.diagnostics.switches.at(-1)?.effectiveAt ??
            document.querySelector('video').currentTime,
        );
        await page.waitForFunction(
          (t) => document.querySelector('video').currentTime > t + 2,
          boundary,
          { timeout: 45000 },
        );
      }
      if (source.id === 'apple-av1') {
        assert.match(
          await page.evaluate(
            () =>
              window.player.catalog.tracks.find((t) => t.kind === 'video')
                .codec,
          ),
          /^av01\./,
        );
        await page.evaluate(() => {
          document.querySelector('video').currentTime = 60;
        });
        await page.waitForFunction(
          () => document.querySelector('video').currentTime > 63,
        );
        const previousAudio = await page.evaluate(
          () => document.querySelector('video').webkitAudioDecodedByteCount,
        );
        await page.evaluate(() =>
          window.player.selectAudioTrack(
            window.player.audioTracks.find((t) => t.label.includes('DVS')).name,
          ),
        );
        await page.waitForFunction(
          (n) =>
            document.querySelector('video').webkitAudioDecodedByteCount > n,
          previousAudio,
        );
      }
      if (source.id === 'apple-dv-atmos') {
        assert.equal(
          await page.locator('#placeholder h2').textContent(),
          'ThePlayer',
        );
        await page.evaluate(() => {
          window.player.selectSubtitleTrack('hls-608-1');
          document.querySelector('video').currentTime = 60;
        });
        await page.waitForFunction(
          () =>
            document.querySelector('video').currentTime > 63 &&
            Array.from(document.querySelector('video').textTracks).some(
              (t) =>
                t.mode === 'showing' &&
                Array.from(t.activeCues ?? []).some((c) => c.id === 'cea608'),
            ),
          null,
          { timeout: 45000 },
        );
        assert.equal(
          await page.evaluate(
            () => window.player.diagnostics.captions608.warning,
          ),
          '',
        );
        assert.equal(
          await page.evaluate(
            () => window.player.diagnostics.captions608.parityErrors,
          ),
          0,
        );
        await page.evaluate(() => window.player.selectQuality(0));
        await page.waitForFunction(
          () => window.player.currentQuality === 0,
          null,
          { timeout: 30000 },
        );
        await page.waitForFunction(
          () => {
            const video = document.querySelector('video');
            return (
              video.currentTime >
                window.player.diagnostics.switches.at(-1).effectiveAt + 0.5 &&
              Array.from(video.textTracks).some(
                (t) =>
                  t.mode === 'showing' &&
                  Array.from(t.activeCues ?? []).some((c) => c.id === 'cea608'),
              )
            );
          },
          null,
          { timeout: 45000 },
        );
      }
      const tracks = await page.evaluate(() => window.player.subtitleTracks);
      if (tracks.length) {
        await page.evaluate(() =>
          window.player.selectSubtitleTrack(
            (
              window.player.subtitleTracks.find(
                (t) => t.label === 'English' && !t.forced,
              ) ?? window.player.subtitleTracks[0]
            ).name,
          ),
        );
        await page.waitForFunction(
          () =>
            Array.from(document.querySelector('video').textTracks).some(
              (t) => t.activeCues?.length,
            ),
          null,
          { timeout: 20000 },
        );
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(
        await page.evaluate(() => window.__moq.diagnostics.errors),
        [],
      );
      results.push({
        id: source.id,
        url: source.url,
        status: 'passed',
        ...(await page.evaluate(() => ({
          frames: document.querySelector('video').getVideoPlaybackQuality()
            .totalVideoFrames,
          audioBytes:
            document.querySelector('video').webkitAudioDecodedByteCount,
          qualities: window.player.qualityLevels.length,
          audioTracks: window.player.audioTracks,
          subtitles: window.player.subtitleTracks,
          diagnostics: window.player.diagnostics,
        }))),
      });
    } catch (error) {
      results.push({
        id: source.id,
        url: source.url,
        status: 'failed',
        error: String(error),
        failed,
        ...(await page.evaluate(() => ({
          diagnostics: window.player?.diagnostics,
          errors: window.__moq?.diagnostics.errors,
          videoError: document.querySelector('video').error?.message,
        }))),
      });
    } finally {
      await page.close();
    }
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(
  new URL('hls-public.json', output),
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
);
if (results.some((r) => r.status !== 'passed')) process.exitCode = 1;
