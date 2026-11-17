// Optional network audit, not a full conformance certificate or an offline CI gate.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { muxSources } from './mux-sources.mjs';
const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const server = createServer(async (req, res) => {
  try {
    const file = path.resolve(
      root,
      new URL(req.url, 'http://localhost').pathname.slice(1) || 'index.html',
    );
    if (!file.startsWith(root + path.sep)) throw new Error('path');
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
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const results = [];
async function audit(source) {
  const page = await browser.newPage(),
    errors = [],
    requests = [];
  let phase = 'startup';
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('requestfailed', (r) =>
    requests.push({ url: r.url(), reason: r.failure()?.errorText }),
  );
  const result = { id: source.id, name: source.name, url: source.url };
  try {
    await page.goto(
      base +
        '/embed.html?' +
        new URLSearchParams({ src: source.url, quality: '0' }),
    );
    await page.waitForFunction(
      () =>
        window.player?.diagnostics?.state === 'error' ||
        window.__moq?.diagnostics?.errors?.length ||
        document.querySelector('video').getVideoPlaybackQuality()
          .totalVideoFrames > 60,
      null,
      { timeout: 40000 },
    );
    const startupError = await page.evaluate(() =>
      window.__moq?.diagnostics.errors.join('; '),
    );
    if (startupError) throw new Error(startupError);
    const before = await page.evaluate(() => ({
      time: document.querySelector('video').currentTime,
      frames: document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames,
    }));
    phase = 'continued playback';
    await page.waitForFunction(
      (t) => document.querySelector('video').currentTime > t + 12,
      before.time,
      { timeout: 25000 },
    );
    const levels = await page.evaluate(() => window.player.qualityLevels);
    if (levels.length > 1) {
      phase = 'quality transition';
      await page.evaluate(() =>
        Promise.race([
          window.player.selectQuality(1),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Switch timeout')), 20000),
          ),
        ]),
      );
      const boundary = await page.evaluate(
        () => window.player.diagnostics.switches.at(-1).effectiveAt,
      );
      await page.waitForFunction(
        (t) => document.querySelector('video').currentTime > t + 3,
        boundary,
        { timeout: 20000 },
      );
    }
    if (source.boundary) {
      phase = 'ad discontinuity';
      await page.evaluate((t) => {
        document.querySelector('video').currentTime = t - 2;
      }, source.boundary);
      await page.waitForFunction(
        (t) => document.querySelector('video').currentTime > t + 3,
        source.boundary,
        { timeout: 20000 },
      );
    }
    const state = await page.evaluate(() => ({
      time: document.querySelector('video').currentTime,
      frames: document.querySelector('video').getVideoPlaybackQuality()
        .totalVideoFrames,
      audioBytes: document.querySelector('video').webkitAudioDecodedByteCount,
      buffer: window.player.diagnostics.buffer,
      qualities: window.player.qualityLevels.length,
      errors: window.__moq.diagnostics.errors,
    }));
    if (
      state.frames <= before.frames + 100 ||
      state.errors.length ||
      errors.length
    )
      throw new Error('Rendering did not continue cleanly');
    Object.assign(result, { status: 'passed', ...state });
  } catch (error) {
    const details = await page.evaluate(() => ({
      diagnostics: window.player?.diagnostics,
      errors: window.__moq?.diagnostics.errors,
      time: document.querySelector('video')?.currentTime,
    }));
    const message = String(error) + ' ' + (details.errors ?? []).join('; ');
    Object.assign(result, {
      status:
        source.limitation && message.includes(source.limitation)
          ? 'unsupported'
          : 'failed',
      phase,
      message,
      ...details,
      requests,
      pageErrors: errors,
    });
  } finally {
    await page.close();
  }
  results.push(result);
  console.log(JSON.stringify(result));
}
try {
  const sources = muxSources.filter(
    (s) =>
      !process.env.HLS_PUBLIC_SOURCE || s.id === process.env.HLS_PUBLIC_SOURCE,
  );
  for (let i = 0; i < sources.length; i += 2)
    await Promise.all(sources.slice(i, i + 2).map(audit));
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
const directory = new URL('../test-results/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(
  new URL('mux-audit.json', directory),
  JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2),
);
if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
