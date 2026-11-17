import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const root =
  process.env.THEPLAYER_HLS_FIXTURES ??
  path.join(os.tmpdir(), 'theplayer-hls-fixtures');
const dist =
  process.env.THEPLAYER_DIST ??
  fileURLToPath(new URL('../dist/', import.meta.url));
const bundle = await build({
  entryPoints: [
    new URL('../src/engines/hls/ttml.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const vttBundle = await build({
  entryPoints: [
    new URL('../src/engines/hls/subtitles.ts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
});
const server = createServer(async (req, res) => {
  const name = new URL(req.url, 'http://localhost').pathname;
  try {
    if (name === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end(
        '<div style="width:640px;height:360px;position:relative"><video style="width:640px;height:360px" muted></video></div>',
      );
    }
    if (name === '/vtt-parser.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(vttBundle.outputFiles[0].text);
    }
    if (name === '/ttml-parser.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(bundle.outputFiles[0].text);
    }
    const fixture = name.startsWith('/fixture/');
    const file = path.resolve(
      fixture ? root : dist,
      name.slice(fixture ? 9 : 1),
    );
    if (!file.startsWith((fixture ? root : dist) + path.sep))
      throw new Error('path');
    res.setHeader(
      'Content-Type',
      file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.m3u8')
          ? 'application/vnd.apple.mpegurl'
          : 'application/octet-stream',
    );
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const transport of ['fetch', 'xhr']) {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    const errors = [],
      resourceTypes = [];
    page.on('request', (request) => {
      if (request.url().includes('/fixture/'))
        resourceTypes.push(request.resourceType());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/ttml-parser.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: bundle.outputFiles[0].text,
      }),
    );
    await page.route('**/vtt-parser.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: vttBundle.outputFiles[0].text,
      }),
    );
    await page.goto(
      process.env.HLS_RECOVERY_BASE ? base + '/harness.html' : base,
    );
    await page.evaluate(() => {
      const video = document.querySelector('video');
      video.style.width = '640px';
      video.style.height = '360px';
      video.parentElement.style.width = '640px';
      video.parentElement.style.height = '360px';
      video.parentElement.style.position = 'relative';
    });
    const parsed = await page.evaluate(async () => {
      const { parseTtml, ttmlTime } = await import('/ttml-parser.js');
      const rates = { frame: 25, subFrame: 10, tick: 100 };
      const times = [
        '00:01:02.500',
        '00:00:01:12.5',
        '500ms',
        '50f',
        '150t',
      ].map((v) => ttmlTime(v, rates));
      const prefix =
        '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">';
      const doc = parseTtml(
        prefix +
          '<body begin="1s"><div><p begin="2s" dur="3s">One<span begin="1s" dur="1s"> two</span><br/>Three</p></div></body></tt>',
        0,
        10,
      );
      let rejected = 0;
      for (const xml of [
        prefix +
          '<head><styling><style xml:id="a" style="b"/><style xml:id="b" style="a"/></styling></head><body><p style="a">bad</p></body></tt>',
        '<!DOCTYPE tt SYSTEM "https://example.test/never">' + prefix + '</tt>',
        '<tt>',
      ]) {
        try {
          parseTtml(xml, 0, 10);
        } catch {
          rejected++;
        }
      }
      const styled = parseTtml(
        prefix +
          '<body><p dur="2s" tts:fontSize="50%" tts:opacity="0.5">Base<span tts:fontSize="50%" tts:opacity="0.5">Small</span></p></body></tt>',
        0,
        2,
      );
      return { times, doc, rejected, styled };
    });
    assert.deepEqual(parsed.times, [62.5, 1.5, 0.5, 2, 1.5]);
    assert.equal(parsed.doc.paragraphs[0].start, 3);
    assert.equal(parsed.doc.paragraphs[0].end, 6);
    assert.equal(
      parsed.doc.paragraphs[0].runs.find((r) => r.text.includes('two')).start,
      4,
    );
    assert.equal(parsed.rejected, 3);
    assert.equal(parsed.styled.paragraphs[0].style.fontSize, '0.5c');
    assert.equal(parsed.styled.paragraphs[0].runs[0].style.opacity, undefined);
    assert.equal(parsed.styled.paragraphs[0].runs[1].style.fontSize, '0.25c');
    assert.equal(parsed.styled.paragraphs[0].runs[1].style.opacity, '0.5');
    const vtt = await page.evaluate(async () => {
      const { vttHeaders, nativeCue, WebVttStyles, parseVtt } = await import(
        '/vtt-parser.js'
      );
      const text =
        'WEBVTT\n\nSTYLE\n::cue(.yellow) { color: yellow; font-weight: bold }\n\nREGION\nid:bottom\nwidth:80%\nlines:3\nregionanchor:0%,100%\nviewportanchor:10%,90%\nscroll:up\n\n00:00:01.000 --> 00:00:03.000 region:bottom line:80%,end position:10%,line-left align:start\n<c.yellow>Styled cue</c>\n';
      const headers = vttHeaders(text),
        cue = nativeCue(parseVtt(text)[0], headers.regions);
      const styles = new WebVttStyles(document.querySelector('video'));
      styles.add(headers.styles[0]);
      styles.add(
        'body { color:red } ::cue { background-image: url(https://example.test/never) }',
      );
      const rules = [...document.querySelectorAll('style')]
        .map((e) => e.textContent)
        .join('');
      const result = {
        width: headers.regions.get('bottom').width,
        anchor: headers.regions.get('bottom').viewportAnchorY,
        line: cue.line,
        lineAlign: cue.lineAlign,
        positionAlign: cue.positionAlign,
        rules,
      };
      styles.destroy();
      return result;
    });
    assert.equal(vtt.width, 80);
    assert.equal(vtt.anchor, 90);
    assert.equal(vtt.line, 80);
    assert.equal(vtt.lineAlign, 'end');
    assert.equal(vtt.positionAlign, 'line-left');
    assert.match(vtt.rules, /data-theplayer-vtt/);
    assert.match(vtt.rules, /color:yellow/);
    assert.doesNotMatch(vtt.rules, /body|example.test/);
    await page.evaluate(
      async ({ url, transport }) => {
        const { ThePlayer } = await import('/player.js');
        window.player = new ThePlayer(document.querySelector('video'));
        window.failures = [];
        for (const name of ['error', 'captionwarning'])
          window.player.addEventListener(name, (e) =>
            window.failures.push(String(e.detail)),
          );
        await window.player.load({
          protocol: 'hls',
          url,
          autoplay: false,
          network: { transport },
        });
      },
      { url: base + '/fixture/text-mp4.m3u8', transport },
    );
    assert.equal(
      await page.evaluate(() => !!globalThis.crypto?.subtle),
      true,
      'Encrypted subtitle tests need HTTPS or localhost',
    );
    await page.waitForSelector('.theplayer-ttml');
    const seek = async (time) => {
      await page.evaluate((time) => {
        document.querySelector('video').currentTime = time;
      }, time);
      await page.waitForFunction(
        (time) =>
          !document.querySelector('video').seeking &&
          Math.abs(document.querySelector('video').currentTime - time) < 0.05,
        time,
      );
    };
    await seek(0.75);
    await page.waitForFunction(() =>
      document
        .querySelector('.theplayer-ttml')
        .textContent.includes('Timed span'),
    );
    let info = await page.evaluate(() => {
      const overlay = document.querySelector('.theplayer-ttml'),
        region = overlay.firstElementChild;
      const yellow = [...region.querySelectorAll('span')].find(
        (e) => e.textContent === 'left aligned',
      );
      return {
        text: overlay.textContent,
        left: parseFloat(region.style.left),
        top: parseFloat(region.style.top),
        width: parseFloat(region.style.width),
        height: parseFloat(region.style.height),
        align: getComputedStyle(region.firstElementChild).textAlign,
        color: getComputedStyle(yellow).color,
      };
    });
    assert.match(info.text, /TTML 0/);
    assert.equal(info.left, 64);
    assert.equal(info.top, 216);
    assert.equal(info.width, 512);
    assert.equal(info.height, 108);
    assert.equal(info.align, 'left');
    assert.equal(info.color, 'rgb(255, 255, 0)');
    await mkdir(new URL('../test-results/', import.meta.url), {
      recursive: true,
    });
    await page.screenshot({
      path: new URL('../test-results/ttml-layout.png', import.meta.url)
        .pathname,
    });
    await seek(1.75);
    await page.waitForFunction(
      () =>
        !document
          .querySelector('.theplayer-ttml')
          .textContent.includes('Timed span'),
    );
    await seek(4.75);
    await page.waitForFunction(() =>
      document.querySelector('.theplayer-ttml').textContent.includes('TTML 2'),
    );
    await page.evaluate(() =>
      window.player.selectSubtitleTrack(
        window.player.subtitleTracks.find(
          (track) => track.label === 'MP4 WebVTT',
        ).name,
      ),
    );
    await page.waitForFunction(() =>
      [...document.querySelector('video').textTracks].some((t) =>
        [...(t.activeCues ?? [])].some((c) => c.text === 'MP4 WebVTT 2'),
      ),
    );
    assert.equal(await page.locator('.theplayer-ttml').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.failures), []);
    await page.evaluate(() =>
      window.player.selectSubtitleTrack(
        window.player.subtitleTracks.find(
          (track) => track.label === 'Encrypted IMSC',
        ).name,
      ),
    );
    await page.waitForFunction(() =>
      document.querySelector('.theplayer-ttml')?.textContent.includes('TTML 2'),
    );
    assert.deepEqual(await page.evaluate(() => window.failures), []);
    await page.evaluate(() => window.player.selectSubtitleTrack(''));
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelector('video').textTracks].some(
          (t) => t.mode === 'showing',
        ),
      ),
      false,
    );
    await page.evaluate(() => window.player.destroy());
    assert.deepEqual(errors, []);
    assert.ok(resourceTypes.length > 5);
    assert.ok(resourceTypes.every((type) => type === transport));
    console.log(
      'PASS stpp/TTML layout, timed spans, seeks, wvtt switching, encrypted text and safe XML',
      transport,
    );
    await page.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
