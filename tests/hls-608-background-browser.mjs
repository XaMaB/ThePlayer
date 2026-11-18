import { chromium, firefox, webkit } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const bundle = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/cea608'; export * from './src/engines/hls/cea608-renderer'; export { WebVttStyles } from './src/engines/hls/subtitles';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const clip = spawnSync(
  'ffmpeg',
  [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=640x360:r=25:d=3',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    'frag_keyframe+empty_moov',
    '-f',
    'mp4',
    'pipe:1',
  ],
  { maxBuffer: 4e6 },
);
if (clip.status) throw new Error(clip.stderr.toString());
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/module.js'
      ? 'application/javascript'
      : req.url === '/clip.mp4'
        ? 'video/mp4'
        : 'text/html',
  );
  res.end(
    req.url === '/module.js'
      ? bundle.outputFiles[0].text
      : req.url === '/clip.mp4'
        ? clip.stdout
        : '<!doctype html><style>body{margin:0}video{width:640px;height:360px}</style><video muted src="/clip.mp4"></video>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
const pixels = (png) => {
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1',
    ],
    { input: png, maxBuffer: 4e6 },
  );
  if (decoded.status) throw new Error(decoded.stderr.toString());
  let red = 0,
    purple = 0;
  for (let i = 0; i < decoded.stdout.length; i += 3) {
    const r = decoded.stdout[i],
      g = decoded.stdout[i + 1],
      b = decoded.stdout[i + 2];
    if (r > 180 && g < 60 && b < 60) red++;
    if (r > 70 && b > 70 && g < 60) purple++;
  }
  return { red, purple };
};
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    const {
      Cea608Decoder,
      Cea608Renderer,
      row608Text,
      cea608Styles,
      WebVttStyles,
    } = await import('/module.js');
    const video = document.querySelector('video');
    await video.play();
    window.track = video.addTextTrack('captions');
    window.track.mode = 'showing';
    if (!CSS.supports('selector(::cue(.cea608))')) {
      window.track.mode = 'hidden';
      window.renderer = new Cea608Renderer(video, () => {});
    }
    window.styles = new WebVttStyles(video);
    window.styles.add(cea608Styles());
    window.caption = (id) => {
      const decoder = new Cea608Decoder();
      const parity = (n) => {
        let bits = 0;
        for (let v = n; v; v >>>= 1) bits ^= v & 1;
        return bits ? n : n | 128;
      };
      const pairs = [
        [0x14, 0x29],
        [32, 0],
        id === 16 ? [0x17, 0x2d] : [0x10, 0x20 + id],
        [65, 66],
        [67, 68],
      ];
      for (const [a, b] of pairs) decoder.push(parity(a), parity(b), 0);
      for (const cue of Array.from(window.track.cues))
        window.track.removeCue(cue);
      const cue = new VTTCue(0, 3, row608Text(decoder.screens(0)[0].rows[0]));
      cue.snapToLines = false;
      cue.line = 50;
      cue.position = 50;
      cue.align = 'center';
      cue.size = 60;
      window.track.addCue(cue);
      window.renderer?.set(decoder.screens(0).filter((s) => s.service === 1));
      return {
        text: cue.text,
        rules: document.querySelector('style:last-of-type').textContent,
      };
    };
  });
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 0.2,
  );
  await page.evaluate(() => document.querySelector('video').pause());
  const measured = [];
  for (const id of [8, 9, 16]) {
    const cue = await page.evaluate((id) => window.caption(id), id);
    assert.match(cue.text, new RegExp('cea608-bg' + id));
    await page.waitForFunction(() => window.track.activeCues?.length === 1);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    measured.push(pixels(await page.screenshot()));
  }
  assert.ok(measured[0].red > 100, JSON.stringify(measured));
  assert.ok(measured[1].purple > 100, JSON.stringify(measured));
  assert.equal(measured[2].red, 0);
  assert.equal(measured[2].purple, 0);
  await page.evaluate(() => {
    window.styles.destroy();
    window.renderer?.destroy();
  });
  assert.equal(await page.locator('video[data-theplayer-vtt]').count(), 0);
  console.log(
    'PASS decoded CEA-608 opaque, translucent and transparent caption pixels',
    name,
    measured,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
