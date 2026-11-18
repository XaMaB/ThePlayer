import { chromium, firefox, webkit } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const bundle = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/ttml';export * from './src/engines/hls/ttml-renderer';",
    resolveDir: new URL('..', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'esm',
});
const server = createServer((req, res) => {
  res.setHeader(
    'Content-Type',
    req.url === '/module.js' ? 'application/javascript' : 'text/html',
  );
  res.end(
    req.url === '/module.js'
      ? bundle.outputFiles[0].text
      : '<!doctype html><div style="width:640px;height:360px"><video style="width:640px;height:360px"></video></div>',
  );
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium' ? { args: ['--no-sandbox'] } : {},
);
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const { parseTtml, TtmlRenderer } = await import('/module.js');
    const header =
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling">';
    const xml =
      header +
      '<body><p begin="2s" dur="6s" tts:color="white" tts:fontSize="2c"><set begin="1s" dur="3s" tts:color="red" tts:fontSize="4c"/><set begin="2s" dur="1s" tts:color="lime"/>A<span tts:color="blue" tts:fontSize="50%">B</span></p></body></tt>';
    const doc = parseTtml(xml, 0, 10, 10);
    const at = (d, t) =>
      d.paragraphs
        .filter((p) => p.start <= t && p.end > t)
        .flatMap((p) => p.runs.filter((r) => r.start <= t && r.end > t));
    const samples = [12.5, 13.5, 14.5, 15.5, 16.5].map((t) =>
      at(doc, t).map((r) => ({
        text: r.text,
        color: r.style.color,
        size: r.style.fontSize,
      })),
    );
    const freeze = parseTtml(
      header +
        '<body><p dur="6s" tts:color="white"><set begin="1s" dur="1s" fill="freeze" tts:color="red"/>Freeze</p></body></tt>',
      0,
      6,
    );
    const out = parseTtml(
      header +
        '<head><animation><set xml:id="flash" begin="1s" dur="1s" tts:color="red"/></animation></head><body><p begin="2s" dur="4s" animate="flash" tts:color="white">Ref</p></body></tt>',
      0,
      6,
    );
    const region = parseTtml(
      header +
        '<head><layout><region xml:id="r" timeContainer="seq" tts:extent="50% 20%"><set dur="1s" tts:origin="10% 10%"/><set dur="1s" tts:origin="20% 20%"/></region></layout></head><body region="r"><p dur="3s">Move</p></body></tt>',
      0,
      3,
    );
    const regionAt = (t) => {
      const p = region.paragraphs.find((p) => p.start <= t && p.end > t);
      return region.regions[p.region].origin;
    };
    const repeated = parseTtml(
      header +
        '<body><p dur="6s" tts:color="white"><set begin="1s" dur="1s" repeatCount="3" tts:color="red"/>Repeat</p></body></tt>',
      0,
      6,
    );
    const sequential = parseTtml(
      header +
        '<body><div timeContainer="seq"><set dur="1s" repeatCount="2" tts:color="red"/><p dur="2s">After</p></div></body></tt>',
      0,
      5,
    );
    const rejected = [];
    for (const attrs of [
      'fill="bad"',
      'repeatCount="0"',
      'repeatCount="Infinity"',
      'tts:color="red;blue"',
    ]) {
      try {
        parseTtml(
          header + '<body><p dur="2s"><set ' + attrs + '/>Bad</p></body></tt>',
          0,
          2,
        );
        rejected.push(false);
      } catch {
        rejected.push(true);
      }
    }
    const video = document.querySelector('video');
    let now = 12.5;
    Object.defineProperty(video, 'currentTime', { get: () => now });
    const renderer = new TtmlRenderer(video, () => {});
    renderer.add(doc);
    const rendered = [];
    for (const t of [12.5, 13.5, 14.5, 16.5, 13.5]) {
      now = t;
      video.dispatchEvent(new Event('seeked'));
      rendered.push(
        [...renderer.element.querySelectorAll('span')].map((s) => ({
          color: getComputedStyle(s).color,
          size: getComputedStyle(s).fontSize,
        })),
      );
    }
    renderer.destroy();
    return {
      sequential: sequential.paragraphs.map((p) => [p.start, p.end]),
      rejected,
      samples,
      freeze: at(freeze, 4)[0].style.color,
      reference: [2.5, 3.5, 4.5].map((t) => at(out, t)[0].style.color),
      region: [0.5, 1.5, 2.5].map(regionAt),
      repeat: [0.5, 1.5, 3.5, 4.5].map((t) => at(repeated, t)[0].style.color),
      rendered,
    };
  });
  assert.deepEqual(
    result.samples.map((s) => s[0].color),
    ['white', 'red', 'lime', 'red', 'white'],
  );
  assert.deepEqual(
    result.samples.map((s) => s[1].color),
    Array(5).fill('blue'),
  );
  assert.deepEqual(
    result.samples.map((s) => s[1].size),
    ['1c', '2c', '2c', '2c', '1c'],
  );
  assert.deepEqual(result.sequential, [[2, 4]]);
  assert.deepEqual(result.rejected, [true, true, true, true]);
  assert.equal(result.freeze, 'red');
  assert.deepEqual(result.reference, ['white', 'red', 'white']);
  assert.deepEqual(result.region, ['10% 10%', '20% 20%', undefined]);
  assert.deepEqual(result.repeat, ['white', 'red', 'red', 'white']);
  assert.deepEqual(
    result.rendered.map((s) => s[0].color),
    [
      'rgb(255, 255, 255)',
      'rgb(255, 0, 0)',
      'rgb(0, 255, 0)',
      'rgb(255, 255, 255)',
      'rgb(255, 0, 0)',
    ],
  );
  assert.deepEqual(result.rendered[1], result.rendered[4]);
  console.log(
    'PASS TTML discrete animations: inheritance, font scaling, overlap, freeze, references, regions, repeats and backward seeks',
    name,
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
