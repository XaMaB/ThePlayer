import { chromium, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const name = process.env.CONTROLS_TEST_BROWSER ?? 'webkit';
const browser = await { chromium, webkit }[name].launch();
const deadline = setTimeout(() => process.exit(1), 60000);
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
    window.paused = false;
    window.pauseCalls = 0;
    window.playCalls = 0;
    Object.defineProperties(video, {
      paused: { get: () => window.paused },
      readyState: { get: () => 4 },
      duration: { get: () => 120 },
      currentTime: { value: 30, writable: true },
    });
    video.pause = () => {
      window.paused = true;
      window.pauseCalls++;
      video.dispatchEvent(new Event('pause'));
    };
    video.play = async () => {
      window.paused = false;
      window.playCalls++;
      video.dispatchEvent(new Event('play'));
    };
    const player = Object.assign(new EventTarget(), {
      isLive: false,
      play: () => video.play(),
      audioTracks: [],
      subtitleTracks: [],
    });
    window.remountControls = (options) =>
      mountControls(
        screen,
        video,
        () => player,
        () => {},
        options,
      );
    window.controls = mountControls(
      screen,
      video,
      () => player,
      () => {},
    );
  });
  await page.waitForTimeout(600);
  const hidden = () =>
    page
      .locator('.screen')
      .evaluate((s) => s.classList.contains('controls-hidden'));
  await page
    .locator('.screen')
    .evaluate((s) => s.classList.add('controls-hidden'));
  // Safari's non-hover pointer boundary sequence, before any compatibility click.
  await page
    .locator('.screen')
    .dispatchEvent('pointerenter', { pointerType: 'touch', pointerId: 9 });
  await page.locator('video').dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 9,
    bubbles: true,
  });
  await page.locator('video').dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 9,
    bubbles: true,
  });
  await page
    .locator('.screen')
    .dispatchEvent('pointerleave', { pointerType: 'touch', pointerId: 9 });
  assert.equal(
    await hidden(),
    false,
    'non-hover pointerleave must retain controls during playback',
  );
  await page
    .locator('.screen')
    .evaluate((s) => s.classList.add('controls-hidden'));
  const bounds = await page.locator('video').boundingBox();
  await page.touchscreen.tap(bounds.x + 70, bounds.y + 70);
  await page
    .locator('.screen')
    .dispatchEvent('pointerleave', { pointerType: 'touch', pointerId: 1 });
  assert.equal(await hidden(), false, 'finger lift must not hide the controls');
  assert.equal(
    await page.evaluate(() => pauseCalls),
    0,
    'reveal tap must not pause playback',
  );
  await page.waitForTimeout(700);
  assert.equal(
    await hidden(),
    false,
    'controls remain available after finger lift',
  );
  await page.locator('#skip-forward').tap();
  assert.equal(await page.locator('video').evaluate((v) => v.currentTime), 40);
  await page.locator('#center-play').tap();
  assert.equal(await page.evaluate(() => pauseCalls), 1);
  await page.locator('#center-play').tap();
  assert.equal(await page.evaluate(() => playCalls), 1);
  await page.locator('.screen').evaluate((s) => s.focus());
  // Keep an active touch longer than the idle timeout, then release outside.
  await page.locator('video').dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId: 42,
    bubbles: true,
  });
  await page.waitForTimeout(1800);
  assert.equal(await hidden(), false, 'do not hide during a held gesture');
  await page.locator('body').dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId: 42,
    bubbles: true,
  });
  await page.waitForTimeout(700);
  assert.equal(await hidden(), false, 'release restarts the idle timeout');
  await page.waitForFunction(
    () =>
      document.querySelector('.screen').classList.contains('controls-hidden'),
    null,
    { timeout: 1500 },
  );
  // Real mouse behavior on a hybrid device remains unchanged.
  await page.locator('video').click({ position: { x: 70, y: 70 } });
  assert.equal(await page.evaluate(() => pauseCalls), 2);
  await page.locator('video').click({ position: { x: 70, y: 70 } });
  assert.equal(await page.evaluate(() => playCalls), 2);
  await page
    .locator('.screen')
    .dispatchEvent('pointerleave', { pointerType: 'mouse' });
  assert.equal(
    await hidden(),
    false,
    'mouse exit also respects the idle timeout',
  );
  await page.waitForFunction(() =>
    document.querySelector('.screen').classList.contains('controls-hidden'),
  );
  await page.evaluate(() => {
    controls.destroy();
    window.controls = remountControls({ autoHideDelayMs: 200 });
  });
  await page.waitForFunction(
    () =>
      document.querySelector('.screen').classList.contains('controls-hidden'),
    null,
    { timeout: 1500 },
  );
  await page
    .locator('video')
    .dispatchEvent('pointermove', { pointerType: 'mouse', bubbles: true });
  await page.locator('#info-toggle').click();
  await page.waitForTimeout(400);
  assert.equal(await hidden(), false, 'open menus keep controls visible');
  await page.mouse.click(950, 650);
  await page.waitForFunction(
    () =>
      document.querySelector('.screen').classList.contains('controls-hidden'),
    null,
    { timeout: 1500 },
  );
  await page.locator('video').evaluate((v) => v.pause());
  await page.waitForTimeout(400);
  assert.equal(await hidden(), false, 'paused playback keeps controls visible');
  await page.locator('video').evaluate((v) => v.play());
  await page.waitForFunction(
    () =>
      document.querySelector('.screen').classList.contains('controls-hidden'),
    null,
    { timeout: 1500 },
  );
  await page.evaluate(() => {
    controls.destroy();
    window.controls = remountControls({ autoHideDelayMs: 0 });
  });
  await page
    .locator('.screen')
    .dispatchEvent('pointerleave', { pointerType: 'mouse' });
  await page.waitForTimeout(1800);
  assert.equal(await hidden(), false, 'zero disables automatic hiding');
  for (const value of [-1, NaN, Infinity, 2147483648])
    assert.equal(
      await page.evaluate((value) => {
        try {
          remountControls({ autoHideDelayMs: value });
          return false;
        } catch (e) {
          return e instanceof RangeError;
        }
      }, value),
      true,
    );
  assert.deepEqual(errors, []);
  await page.evaluate(() => controls.destroy());
  console.log(
    name,
    'touch reveal, delayed hide, seek/play buttons, held gesture, configurable timeout, menus and mouse compatibility PASS',
  );
} finally {
  clearTimeout(deadline);
  await browser.close();
  await new Promise((r) => server.close(r));
}
