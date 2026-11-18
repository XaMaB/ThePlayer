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
    const pair = (side) =>
      `<span tts:ruby="container"><span tts:ruby="base">BASE</span><span tts:ruby="delimiter">(</span><span tts:ruby="text" tts:rubyPosition="${side}">note</span><span tts:ruby="delimiter">)</span></span>`;
    const simple = parseTtml(
      header +
        '<head><layout><region xml:id="r" tts:origin="10% 20%" tts:extent="80% 70%"/></layout></head><body region="r"><p dur="5s" tts:fontSize="2c">' +
        pair('before') +
        ' ' +
        pair('after') +
        '</p></body></tt>',
      0,
      5,
    );
    const double = parseTtml(
      header +
        '<body><p dur="5s" tts:fontSize="2c"><span tts:ruby="container"><span tts:ruby="baseContainer"><span tts:ruby="base">ONE</span><span tts:ruby="base">TWO</span></span><span tts:ruby="textContainer" tts:rubyPosition="before"><span tts:ruby="text">top1</span><span tts:ruby="text">top2</span></span><span tts:ruby="textContainer" tts:rubyPosition="after"><span tts:ruby="text">low1</span><span tts:ruby="text">low2</span></span></span></p></body></tt>',
      0,
      5,
    );
    const timed = parseTtml(
      header +
        '<body><p dur="5s" tts:fontSize="2c"><span tts:ruby="container"><span tts:ruby="base">BASE</span><span tts:ruby="text" begin="1s" end="3s">Timed</span></span></p></body></tt>',
      0,
      5,
    );
    const video = document.querySelector('video');
    let now = 0.5;
    Object.defineProperty(video, 'currentTime', { get: () => now });
    const renderer = new TtmlRenderer(video, () => {});
    renderer.add(simple);
    const geometry = [...renderer.element.querySelectorAll('ruby')].map((r) => {
      const base = r.querySelector('[data-ruby-base]'),
        text = r.querySelector('rt');
      const b = base.getBoundingClientRect(),
        t = text.getBoundingClientRect();
      return {
        side: r.dataset.rubySide,
        base: [b.top, b.bottom],
        annotation: [t.top, t.bottom],
        baseSize: getComputedStyle(base.querySelector('span')).fontSize,
        textSize: getComputedStyle(text.querySelector('span')).fontSize,
      };
    });
    const delimiters = renderer.element.textContent.includes('(');
    renderer.destroy();
    const second = new TtmlRenderer(video, () => {});
    second.add(double);
    const pairs = [...second.element.querySelectorAll('[data-ruby-base]')].map(
      (b) => ({ index: b.dataset.rubyBase, text: b.textContent }),
    );
    const annotations = [...second.element.querySelectorAll('rt')].map(
      (t) => t.textContent,
    );
    second.destroy();
    const third = new TtmlRenderer(video, () => {});
    third.add(timed);
    const times = [];
    for (const t of [0.5, 1.5, 3.5, 1.5]) {
      now = t;
      video.dispatchEvent(new Event('seeked'));
      times.push(third.element.querySelectorAll('rt').length);
    }
    third.destroy();
    return {
      geometry,
      delimiters,
      pairs,
      annotations,
      times,
      roles: double.paragraphs[0].runs.map((r) => [
        r.ruby.role,
        r.ruby.index,
        r.ruby.side,
        r.style.fontSize,
      ]),
    };
  });
  assert.equal(result.delimiters, false);
  assert.equal(result.geometry.length, 2);
  for (const item of result.geometry) {
    assert.equal(item.baseSize, '48px');
    assert.equal(item.textSize, '24px');
    if (item.side === 'before')
      assert.ok(
        item.annotation[0] < item.base[0] && item.annotation[1] < item.base[1],
        JSON.stringify(item),
      );
    else
      assert.ok(
        item.annotation[0] > item.base[0] && item.annotation[1] > item.base[1],
        JSON.stringify(item),
      );
  }
  assert.deepEqual(result.pairs, [
    { index: '0', text: 'ONE' },
    { index: '1', text: 'TWO' },
  ]);
  assert.deepEqual(result.annotations.sort(), ['low1', 'low2', 'top1', 'top2']);
  assert.deepEqual(result.times, [0, 1, 0, 1]);
  console.log(
    'PASS TTML ruby geometry, inherited half-size, paired/double annotations, delimiters and timed seek',
    name,
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
