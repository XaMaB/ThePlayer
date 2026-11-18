import { chromium, firefox, webkit } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const bundle = await build({
  stdin: {
    contents:
      "export * from './src/engines/hls/cea708-service'; export * from './src/engines/hls/cea708-renderer';",
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
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium' ? { args: ['--no-sandbox'] } : {},
);
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async () => {
    const { Cea708Service, Cea708Renderer } = await import('/module.js');
    const video = document.querySelector('video');
    let clock = 0;
    Object.defineProperty(video, 'currentTime', { get: () => clock });
    const service = new Cea708Service(1),
      events = [];
    const push = (data, time) =>
      events.push(...service.push(Uint8Array.from(data), time));
    push(
      [0x98, 24, 128, 0, 1, 9, 9, 0x97, 0, 0, 3, 0x21, 65, 32, 66, 32, 67],
      0,
    );
    push([0x89, 1], 1);
    push([0x8a, 1], 3);
    const renderer = new Cea708Renderer(video, () => {});
    const at = (time) => {
      clock = time;
      renderer.set(events);
      return renderer.element.querySelector('[data-window]');
    };
    const shown = at(1.5),
      box = shown.getBoundingClientRect();
    const glyphs = Array.from(shown.querySelectorAll('span')).filter((span) =>
      span.textContent.trim(),
    );
    const centers = glyphs.map(
      (span) => span.getBoundingClientRect().left - box.left,
    );
    const halfIn = Number(shown.style.opacity);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pausedOpacity = Number(
      renderer.element.firstElementChild.style.opacity,
    );
    const halfOut = Number(at(3.5).style.opacity);
    const gone = !at(4);
    const backwards = Number(at(1.25).style.opacity);
    renderer.destroy();
    const wipes = [];
    for (let direction = 0; direction < 4; direction++) {
      const s = new Cea708Service(1),
        frames = [];
      frames.push(
        ...s.push(
          Uint8Array.from([
            0x98,
            24,
            128,
            0,
            1,
            9,
            9,
            0x97,
            0,
            0,
            0,
            0x22 | (direction << 2),
            88,
          ]),
          0,
        ),
      );
      frames.push(...s.push(Uint8Array.of(0x89, 1), 1));
      frames.push(...s.push(Uint8Array.of(0x8a, 1), 3));
      const r = new Cea708Renderer(video, () => {});
      clock = 1.5;
      r.set(frames);
      const reveal = r.element.firstElementChild.style.clipPath;
      clock = 3.5;
      r.set(frames);
      const hide = r.element.firstElementChild.style.clipPath;
      wipes.push({ reveal, hide });
      r.destroy();
    }
    return {
      halfIn,
      pausedOpacity,
      halfOut,
      gone,
      backwards,
      centers,
      width: box.width,
      wipes,
      overlays: document.querySelectorAll('.theplayer-cea708').length,
    };
  });
  assert.equal(result.halfIn, 0.5);
  assert.equal(result.pausedOpacity, 0.5);
  assert.equal(result.halfOut, 0.5);
  assert.equal(result.gone, true);
  assert.equal(result.backwards, 0.25);
  assert.equal(result.overlays, 0);
  assert.ok(Math.abs(result.centers[2] - result.width * 0.9) < 1);
  assert.ok(Math.abs(result.centers[1] - result.width * 0.45) < 1);
  for (const wipe of result.wipes) {
    assert.ok(wipe.reveal.includes('50%'));
    assert.notEqual(wipe.reveal, wipe.hide);
  }
  console.log(
    'PASS decoded CEA-708 fade, directional wipes, full word spacing, pause, reverse seek and cleanup',
    name,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
