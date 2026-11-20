import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, firefox, webkit } from 'playwright';
import { faultServer } from './helpers/hls-fault-server.mjs';

// Adapter + canvas integration with real fMP4 playback. Transport is exercised
// separately by the deployment's isolated Origin/Relay fixture publisher.
const bundle = await build({
  stdin: {
    contents: `export { Cea708Decoder } from './src/subtitles/cea708/decoder';
      export { SubtitleRenderer } from './src/subtitles/renderer';`,
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
});
const { server } = faultServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const name = process.env.MOQ_CAPTION_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/caption-adapter.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: bundle.outputFiles[0].text,
    }),
  );
  await page.goto(base + '/harness.html');
  await page.evaluate(async () => {
    const { ThePlayer } = await import('/player.js');
    const { Cea708Decoder, SubtitleRenderer } = await import(
      '/caption-adapter.js'
    );
    const video = document.querySelector('video');
    video.style.cssText = 'width:640px;height:480px;object-fit:contain';
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    window.captionEvents = new EventTarget();
    window.renderer = new SubtitleRenderer(video, canvas);
    window.renderer.attach(window.captionEvents);
    window.draws = [];
    const ctx = canvas.getContext('2d'),
      original = ctx.fillText.bind(ctx);
    ctx.fillText = (...args) => {
      window.draws.push(args);
      original(...args);
    };
    window.player = new ThePlayer(video);
    window.failures = [];
    window.player.addEventListener('error', (e) =>
      window.failures.push(String(e.detail)),
    );
    await window.player.load({
      protocol: 'hls',
      url: location.origin + '/fixture/cea708-mp4.m3u8',
    });
    await window.player.selectSubtitleTrack('');
    const bytes = async (path) =>
      new Uint8Array(
        await (await fetch('/fixture/cea708-mp4/' + path)).arrayBuffer(),
      );
    window.decoder = new Cea708Decoder(await bytes('init.mp4'), {
      SERVICE1: { language: 'eng', label: 'English' },
      SERVICE2: { language: 'bul', label: 'P16' },
    });
    window.first = await bytes('segment00.m4s');
    for (let i = 0; i < 9; i++)
      window.decoder.push(await bytes(`segment0${i}.m4s`), 0);
    window.select = (name) => {
      window.captionEvents.dispatchEvent(new Event('subtitlechange'));
      window.draws = [];
      for (const cue of window.decoder.history(name))
        window.captionEvents.dispatchEvent(
          new CustomEvent('caption', { detail: { cue } }),
        );
    };
    window.pixels = () =>
      canvas
        .getContext('2d')
        .getImageData(0, 0, canvas.width, canvas.height)
        .data.some((v, i) => i % 4 === 3 && v > 0);
    await video.play();
  });
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 0.3,
  );
  await page.evaluate(() => {
    document.querySelector('video').pause();
    window.select('cea708-1');
  });
  await page.waitForFunction(
    () => window.draws.some((d) => d[0] === 'Left aligned') && window.pixels(),
  );
  const state = await page.evaluate(() => ({
    tracks: [...window.decoder.tracks.values()],
    errors: window.decoder.errors,
    draws: window.draws,
    top: parseFloat(document.querySelector('canvas').style.top),
    displayed: window.renderer.counters.displayed,
  }));
  assert.deepEqual(
    state.tracks.map((t) => t.name),
    ['cea708-1', 'cea708-2'],
  );
  assert.equal(state.tracks[0].language, 'eng');
  assert.equal(state.errors, 0);
  assert.ok(
    state.draws.find((d) => d[0] === 'Left aligned')[1] < 160,
    JSON.stringify(state),
  );
  assert.ok(state.top > 40, 'letterboxing offsets the canvas');
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => window.renderer.counters.displayed),
    state.displayed,
    'pause must not inflate displayed counter',
  );
  await page.evaluate(() => window.select('cea708-2'));
  await page.waitForFunction(
    () => window.draws.some((d) => d[0] === 'Ж中가') && window.pixels(),
  );
  await page.evaluate(
    () => (document.querySelector('video').currentTime = 8.75),
  );
  await page.waitForFunction(
    () => !document.querySelector('video').seeking && window.pixels(),
  );
  await page.evaluate(() => {
    window.captionEvents.dispatchEvent(
      new CustomEvent('caption', {
        detail: {
          replaceFrom: 0,
          cue: {
            pts: 0,
            duration: 30,
            text: '',
            windows: [],
            rects: [],
            width: 0,
            height: 0,
          },
        },
      }),
    );
  });
  await page.waitForFunction(() => !window.pixels());
  await page.evaluate(() => {
    const cue = structuredClone(
      window.decoder.history('cea708-1').find((c) => c.text),
    );
    cue.pts = 0;
    cue.text = '<i>plain';
    cue.windows[0].rows = ['<i>plain'];
    window.captionEvents.dispatchEvent(
      new CustomEvent('caption', { detail: { replaceFrom: 0, cue } }),
    );
  });
  await page.waitForFunction(() =>
    window.draws.some((d) => d[0] === '<i>plain'),
  );
  await page.evaluate(() => window.select(''));
  assert.equal(await page.evaluate(() => window.pixels()), false);
  assert.deepEqual(await page.evaluate(() => window.failures), []);
  assert.deepEqual(errors, []);
  await page.evaluate(() => {
    window.renderer.destroy();
    window.player.destroy();
  });
  assert.equal(await page.evaluate(() => window.pixels()), false);
  console.log(
    `PASS MoQ caption adapter/canvas: ${name}, P16, services, layout, pause, seek, retraction, plain text, Off and teardown`,
  );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
