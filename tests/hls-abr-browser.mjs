import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const fixtures =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dist =
  process.env.THEPLAYER_DIST ??
  path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
let slow = false;
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/slow') {
      slow = true;
      res.end('ok');
      return;
    }
    if (url.pathname === '/fast') {
      slow = false;
      res.end('ok');
      return;
    }
    const fixture = url.pathname.startsWith('/fixture/');
    const root = fixture ? fixtures : dist;
    let relative = fixture ? url.pathname.slice(9) : url.pathname.slice(1);
    if (!relative) relative = 'index.html';
    let data;
    if (relative === 'selection.m3u8') {
      const master = await readFile(
        path.join(fixtures, 'renditions.m3u8'),
        'utf8',
      );
      data = Buffer.from(
        master
          .replace(
            '#EXT-X-INDEPENDENT-SEGMENTS',
            '#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="subtitles.m3u8"',
          )
          .replaceAll('AUDIO="audio"', 'AUDIO="audio",SUBTITLES="s"'),
      );
    } else {
      const file = path.resolve(root, relative);
      if (!file.startsWith(root + path.sep)) throw new Error('path');
      data = await readFile(file);
    }
    res.setHeader(
      'Content-Type',
      relative.endsWith('.js')
        ? 'text/javascript'
        : relative.endsWith('.css')
          ? 'text/css'
          : relative.endsWith('.html')
            ? 'text/html'
            : relative.endsWith('.m3u8')
              ? 'application/vnd.apple.mpegurl'
              : 'application/octet-stream',
    );
    if (fixture && relative.endsWith('.m4s'))
      await new Promise((r) =>
        setTimeout(r, ((data.length * 8) / (slow ? 900000 : 2500000)) * 1000),
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
const page = await browser.newPage();
try {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    base +
      '/embed.html?' +
      new URLSearchParams({ src: base + '/fixture/renditions.m3u8' }),
  );
  await page.waitForFunction(
    () =>
      window.player?.autoQuality &&
      window.player.currentQuality === 1 &&
      document.querySelector('video').videoWidth === 640,
    null,
    { timeout: 30000 },
  );
  await page.locator('#screen').hover();
  await page.locator('#quality-toggle').click();
  assert.match(
    await page.locator('#quality-menu [data-track="-1"]').innerText(),
    /Auto\s*360p/,
  );
  await page.locator('#quality-toggle').click();
  await page.evaluate(() => fetch('/slow'));
  await page.waitForFunction(
    () =>
      window.player.currentQuality === 0 &&
      document.querySelector('video').videoWidth === 320,
    null,
    { timeout: 30000 },
  );
  assert.equal(await page.evaluate(() => window.player.autoQuality), true);
  // A fixed choice must remain fixed even after delivery recovers.
  await page.evaluate(() => window.player.selectQuality(0));
  await page.evaluate(() => fetch('/fast'));
  await page.waitForTimeout(4000);
  assert.equal(await page.evaluate(() => window.player.autoQuality), false);
  assert.equal(await page.evaluate(() => window.player.selectedQuality), 0);
  await page.locator('#screen').hover();
  await page.locator('#quality-toggle').click();
  await page.locator('#quality-menu [data-track="-1"]').click();
  assert.equal(await page.evaluate(() => window.player.autoQuality), true);
  await page
    .locator('#screen')
    .click({ button: 'right', position: { x: 40, y: 40 } });
  assert.equal(
    await page.locator('#player-menu .player-brand').innerText(),
    'ThePlayer',
  );
  await page.locator('#stats-toggle').click();
  assert.equal(
    await page.locator('#stats-overlay .player-brand').innerText(),
    'ThePlayer',
  );
  assert.equal(
    await page.locator('#stats-overlay .player-brand svg').count(),
    1,
  );
  assert.match(await page.locator('#stats-quality').innerText(), /Auto/);
  // The language override can select another rendition; DEFAULT subtitles start automatically.
  await page.evaluate(
    (url) =>
      window.player.load({
        protocol: 'hls',
        url,
        quality: 0,
        audioLanguage: 'es',
      }),
    base + '/fixture/selection.m3u8',
  );
  await page.waitForFunction(
    () =>
      window.player.selectedAudioTrack === 'hls-audio-1' &&
      Array.from(document.querySelector('video').textTracks).some(
        (t) => t.activeCues?.length,
      ),
    null,
    { timeout: 15000 },
  );
  assert.equal(
    await page.locator('#subtitle-select').inputValue(),
    'hls-sub-0',
  );
  await page.evaluate(() => window.player.selectSubtitleTrack(''));
  await page.evaluate(() => window.player.selectQuality(1));
  assert.equal(await page.locator('#subtitle-select').inputValue(), '');
  assert.equal(
    await page.evaluate(() =>
      Array.from(document.querySelector('video').textTracks).some(
        (t) => t.mode === 'showing',
      ),
    ),
    false,
  );
  await page.locator('#stats-close').click();
  await page.locator('#screen').hover();
  await page.locator('#quality-toggle').click();
  await mkdir(new URL('../test-results/', import.meta.url), {
    recursive: true,
  });
  await page.screenshot({
    path: fileURLToPath(
      new URL('../test-results/quality-desktop.png', import.meta.url),
    ),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: fileURLToPath(
      new URL('../test-results/quality-mobile.png', import.meta.url),
    ),
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator('#quality-toggle').click();
  await page.setViewportSize({ width: 1280, height: 720 });
  // A video-only source has no alternate audio or captions; disabled is not loading.
  await page.evaluate(
    (url) => window.player.load({ protocol: 'hls', url, quality: 0 }),
    base + '/fixture/video-low/index.m3u8',
  );
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 0.2,
  );
  await page.waitForFunction(
    () =>
      document.querySelector('#audio-toggle').disabled &&
      document.querySelector('#cc-toggle').disabled,
  );
  for (const id of ['audio-toggle', 'cc-toggle'])
    assert.equal(
      await page.locator('#' + id).evaluate((e) => getComputedStyle(e).cursor),
      'default',
    );
  await page.locator('#screen').focus();
  await page.keyboard.press('Space');
  assert.equal(
    await page.evaluate(() => document.querySelector('video').paused),
    true,
  );
  await page.evaluate(() => (document.querySelector('video').currentTime = 1));
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  await page.locator('#skip-forward').click();
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  assert.ok(
    Math.abs(
      (await page.evaluate(() => document.querySelector('video').currentTime)) -
        11,
    ) < 0.1,
  );
  await page.locator('#screen').focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  assert.ok(
    Math.abs(
      (await page.evaluate(() => document.querySelector('video').currentTime)) -
        21,
    ) < 0.1,
  );
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  assert.ok(
    Math.abs(
      (await page.evaluate(() => document.querySelector('video').currentTime)) -
        11,
    ) < 0.1,
  );
  await page.locator('#skip-back').click();
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  assert.ok(
    Math.abs(
      (await page.evaluate(() => document.querySelector('video').currentTime)) -
        1,
    ) < 0.1,
  );
  await page.locator('#screen').focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => !document.querySelector('video').seeking);
  assert.equal(
    await page.evaluate(() => document.querySelector('video').currentTime),
    0,
  );
  await page.locator('#center-play').click();
  await page.waitForFunction(() => !document.querySelector('video').paused);
  await page.keyboard.press('Space');
  assert.equal(
    await page.evaluate(() => document.querySelector('video').paused),
    true,
  );
  // Space must still type normally in forms outside the player.
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'test-editable';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#test-editable').inputValue(), ' ');
  assert.equal(
    await page.evaluate(() => document.querySelector('video').paused),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS automatic up/down switching under controlled delivery, manual lock, Auto UI/current quality, ThePlayer headers, default subtitles, explicit audio language, center controls, keyboard seeking, disabled cursors and mobile layout',
  );
  await page.close();
} catch (error) {
  console.error(
    await page.evaluate(() => ({
      diagnostics: window.player?.diagnostics,
      lanes: window.player?.engine?.lanes().map((l) => ({
        role: l.role,
        next: l.next,
        ranges: Array.from({ length: l.buffer.buffered.length }, (_, i) => [
          l.buffer.buffered.start(i),
          l.buffer.buffered.end(i),
        ]),
      })),
      time: document.querySelector('video')?.currentTime,
      width: document.querySelector('video')?.videoWidth,
      errors: window.__moq?.diagnostics.errors,
    })),
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
