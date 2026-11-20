import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const name = process.env.CONTROLS_TEST_BROWSER ?? 'webkit';
const browser = await { chromium, webkit }[name].launch();
const deadline = setTimeout(() => {
  console.error('Seek preview test timed out');
  process.exit(1);
}, 60000);
try {
  const page = await browser.newPage({
    hasTouch: true,
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/harness.html`);
  await page.evaluate(async () => {
    const { mountControls } = await import('/player.js');
    const video = document.querySelector('video');
    const screen = document.createElement('div');
    screen.className = 'screen';
    screen.style.cssText = 'width:800px;height:450px;position:relative';
    video.before(screen);
    screen.append(video);
    video.style.cssText = 'width:100%;height:100%';
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/style.css';
    document.head.append(css);
    window.duration = 120;
    window.seeks = [];
    let current = 30;
    Object.defineProperties(video, {
      paused: { get: () => false },
      readyState: { get: () => 4 },
      duration: { get: () => window.duration },
      currentTime: {
        get: () => current,
        set: (v) => {
          current = v;
          window.seeks.push(v);
        },
      },
    });
    window.player = Object.assign(new EventTarget(), {
      isLive: false,
      audioTracks: [],
      subtitleTracks: [],
      diagnostics: {},
    });
    window.controls = mountControls(
      screen,
      video,
      () => window.player,
      () => {},
    );
  });
  await page.waitForFunction(
    () => document.querySelector('#seek-bar').max === '120',
  );
  await page.waitForFunction(() => !!document.querySelector('link').sheet);
  const seek = page.locator('#seek-bar'),
    preview = page.locator('#seek-preview');
  const rect = await seek.boundingBox();
  const x = (f) => rect.x + 8 + f * (rect.width - 16),
    y = rect.y + rect.height / 2;
  await page.mouse.move(x(0.505), y);
  await page.waitForFunction(
    () => !document.querySelector('#seek-preview').hidden,
  );
  assert.equal(await preview.locator('span').textContent(), '1:00');
  assert.equal(
    await preview.locator('canvas').isVisible(),
    false,
    'clock works without thumbnail provider',
  );
  await page.screenshot({ path: `/tmp/theplayer-seek-preview-${name}.png` });
  const box = await preview.boundingBox();
  assert.ok(box.y + box.height < rect.y, 'tooltip sits above timeline');
  await page.mouse.down();
  await page.mouse.move(x(0.8), y, { steps: 5 });
  await page.waitForTimeout(650);
  let value = await seek.inputValue();
  assert.ok(Math.abs(Number(value) - 96) < 1, `drag destination ${value}`);
  assert.equal(
    await preview.locator('span').textContent(),
    `${Math.floor(Number(value) / 60)}:${String(Math.floor(Number(value)) % 60).padStart(2, '0')}`,
  );
  assert.equal(
    await page.evaluate(() => document.querySelector('video').currentTime),
    30,
    'drag does not repeatedly seek decoders',
  );
  assert.deepEqual(await page.evaluate(() => window.seeks), []);
  await page.mouse.move(x(0.2), y, { steps: 5 });
  value = await seek.inputValue();
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => document.querySelector('video').currentTime),
    Number(value),
  );
  assert.equal(
    await page.evaluate(() => window.seeks.length),
    1,
    'release commits exactly once',
  );
  assert.equal(await preview.isVisible(), false);
  for (const f of [0, 1]) {
    await page.mouse.move(x(f), y);
    const b = await preview.boundingBox(),
      screen = await page.locator('.screen').boundingBox();
    assert.ok(
      b.x >= screen.x && b.x + b.width <= screen.x + screen.width,
      'edge label remains in player',
    );
    assert.equal(
      await preview.locator('span').textContent(),
      f ? '2:00' : '0:00',
    );
  }
  await page.evaluate(() => {
    window.player.getThumbnail = async () => {
      throw Error('unavailable thumbnail');
    };
  });
  await page.mouse.move(x(0.505), y);
  await page.waitForTimeout(200);
  assert.equal(await preview.isVisible(), true);
  assert.equal(await preview.locator('span').textContent(), '1:00');
  // Keyboard input retains native range semantics and exposes a readable time.
  await seek.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(
    await seek.getAttribute('aria-valuetext'),
    await preview.locator('span').textContent(),
  );
  assert.ok(Number(await seek.inputValue()) > Number(value));
  // Cancelling a captured drag must not commit its destination.
  const committed = await page.evaluate(
    () => document.querySelector('video').currentTime,
  );
  await page.mouse.move(x(0.3), y);
  await page.mouse.down();
  await page.mouse.move(x(0.7), y);
  await seek.dispatchEvent('pointercancel', {
    pointerId: 1,
    pointerType: 'mouse',
  });
  await page.mouse.up();
  assert.equal(
    await page.evaluate(() => document.querySelector('video').currentTime),
    committed,
  );
  assert.equal(await preview.isVisible(), false);
  if (name === 'chromium') {
    const session = await page.context().newCDPSession(page);
    const b = await seek.boundingBox();
    const point = (f) => ({
      x: b.x + 8 + f * (b.width - 16),
      y: b.y + b.height / 2,
    });
    const count = await page.evaluate(() => window.seeks.length);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [point(0.3)],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [point(0.7)],
    });
    await page.waitForTimeout(650);
    const destination = Number(await seek.inputValue());
    assert.ok(Math.abs(destination - 84) < 1, 'touch drag updates destination');
    assert.equal(await page.evaluate(() => window.seeks.length), count);
    assert.equal(await preview.isVisible(), true);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
    assert.equal(
      await page.evaluate(() => document.querySelector('video').currentTime),
      destination,
    );
    assert.equal(await page.evaluate(() => window.seeks.length), count + 1);
    await session.detach();
  }
  await page.evaluate(() => {
    window.duration = 7200;
  });
  await page.waitForFunction(
    () => document.querySelector('#seek-bar').max === '7200',
  );
  await seek.evaluate((el) => {
    el.value = '3600';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(await preview.locator('span').textContent(), '1:00:00');
  await page.mouse.move(20, 20);
  assert.equal(await preview.isVisible(), false);
  await page.evaluate(() => window.controls.destroy());
  assert.equal(await preview.count(), 0);
  // Verify the deferred pointer seek with a real MSE engine, not only a mock clock.
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base + '/harness.html');
  await page.evaluate(async (url) => {
    const { ThePlayer, mountControls } = await import('/player.js');
    const video = document.querySelector('video');
    const screen = document.createElement('div');
    screen.className = 'screen';
    screen.style.cssText = 'width:800px;height:450px;position:relative';
    video.before(screen);
    screen.append(video);
    video.style.cssText = 'width:100%;height:100%';
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/style.css';
    document.head.append(css);
    window.player = new ThePlayer(video);
    window.controls = mountControls(
      screen,
      video,
      () => window.player,
      () => {},
    );
    window.loading = window.player.load({ protocol: 'hls', url, quality: 0 });
  }, base + '/fixture/fmp4/index.m3u8');
  await page.waitForFunction(
    () => document.querySelector('video').currentTime > 1,
    null,
    { timeout: 20000 },
  );
  await page.locator('.screen').hover();
  const realSeek = page.locator('#seek-bar');
  const rb = await realSeek.boundingBox();
  await page.evaluate(() => {
    window.seekEvents = 0;
    document
      .querySelector('video')
      .addEventListener('seeking', () => window.seekEvents++);
  });
  await page.mouse.move(rb.x + 8 + 0.3 * (rb.width - 16), rb.y + rb.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    rb.x + 8 + 0.6 * (rb.width - 16),
    rb.y + rb.height / 2,
    { steps: 4 },
  );
  await page.waitForTimeout(650);
  const target = Number(await realSeek.inputValue());
  assert.ok(target > 9 && target < 12);
  assert.equal(
    await page.evaluate(() => window.seekEvents),
    0,
    'playback continues while previewing',
  );
  await page.mouse.up();
  await page.waitForFunction(
    (t) => document.querySelector('video').currentTime > t + 1.5,
    target,
    { timeout: 15000 },
  );
  assert.equal(
    await page.evaluate(() => window.seekEvents),
    1,
    'real engine seeks once on release',
  );
  assert.ok(
    await page.evaluate(
      () =>
        document.querySelector('video').getVideoPlaybackQuality()
          .totalVideoFrames > 40,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    name,
    'seek destination hover, drag, release, edges, fallback and keyboard PASS',
  );
} finally {
  clearTimeout(deadline);
  await browser.close();
  await new Promise((r) => server.close(r));
}
