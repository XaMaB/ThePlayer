import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dist = process.env.THEPLAYER_DIST
  ? new URL('file://' + process.env.THEPLAYER_DIST + '/')
  : new URL('../dist/', import.meta.url);
let armed = false,
  mode = '',
  bad = 0,
  cancelled = 0;
const server = createServer(async (req, res) => {
  try {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (name === 'harness.html') {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<video muted autoplay></video>');
    }
    if (name.includes('..')) throw new Error('path');
    const data = await readFile(
      name.startsWith('fixture/')
        ? path.join(root, name.slice(8))
        : new URL(name, dist),
    );
    res.setHeader(
      'Content-Type',
      name.endsWith('.js')
        ? 'text/javascript'
        : name.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'application/octet-stream',
    );
    if (armed && name.includes('video-shifted/') && name.endsWith('.m4s')) {
      bad++;
      if (mode === 'http') {
        res.writeHead(503);
        return res.end();
      }
      if (mode === 'body') {
        res.setHeader('Content-Length', data.length);
        let offset = 0;
        const timer = setInterval(() => {
          res.write(data.subarray(offset, offset + 8000));
          offset += 8000;
          if (offset >= data.length) {
            clearInterval(timer);
            res.end();
          }
        }, 250);
        res.on('close', () => {
          clearInterval(timer);
          if (!res.writableFinished) cancelled++;
        });
        return;
      }
      const timer = setTimeout(() => res.end(data), 10000);
      res.on('close', () => {
        clearTimeout(timer);
        if (!res.writableFinished) cancelled++;
      });
      return;
    }
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr'])
    for (const scenario of ['ttfb', 'body', 'http']) {
      armed = false;
      mode = scenario;
      bad = 0;
      cancelled = 0;
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base + '/harness.html');
      await page.evaluate(
        async ({ base, transport }) => {
          const { ThePlayer } = await import('/player.js');
          window.player = new ThePlayer(document.querySelector('video'));
          window.failures = [];
          window.player.addEventListener('error', (event) =>
            window.failures.push(String(event.detail)),
          );
          await window.player.load({
            protocol: 'hls',
            url: base + '/fixture/renditions.m3u8',
            targetBuffer: 4,
            network: { transport, timeoutMs: 15000 },
          });
        },
        { base, transport },
      );
      await page.waitForFunction(
        () => window.player.currentQuality === 1,
        null,
        { timeout: 30000 },
      );
      const before = await page.evaluate(
        () => document.querySelector('video').currentTime,
      );
      armed = true;
      try {
        await page.waitForFunction(
          () =>
            window.player.diagnostics.abrRecovery.failovers > 0 &&
            window.player.currentQuality === 0,
          null,
          { timeout: 15000 },
        );
        await page.waitForFunction(
          (before) => document.querySelector('video').currentTime > before + 5,
          before,
          { timeout: 15000 },
        );
        const info = await page.evaluate(() => ({
          diagnostics: window.player.diagnostics,
          errors: window.failures,
          width: document.querySelector('video').videoWidth,
        }));
        assert.deepEqual(info.errors, []);
        assert.deepEqual(errors, []);
        assert.equal(info.width, 320);
        assert.equal(info.diagnostics.quality.mode, 'auto');
        assert.equal(info.diagnostics.abrRecovery.failovers, 1);
        assert.ok(
          info.diagnostics.abrRecovery.quarantined.some(
            (item) => item.index === 1,
          ),
        );
        if (scenario !== 'http') {
          assert.equal(info.diagnostics.abrRecovery.aborted, 1);
          assert.ok(cancelled > 0);
        } else assert.equal(bad, 3);
        console.log('PASS emergency ABR', transport, scenario, {
          bad,
          cancelled,
        });
      } catch (error) {
        console.error(
          await page.evaluate(() => ({
            diagnostics: window.player.diagnostics,
            errors: window.failures,
            time: document.querySelector('video').currentTime,
          })),
        );
        throw error;
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
