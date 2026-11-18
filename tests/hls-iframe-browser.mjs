import { chromium, firefox, webkit } from 'playwright';
import assert from 'node:assert/strict';
import { faultServer } from './helpers/hls-fault-server.mjs';
const { server } = faultServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base =
  process.env.HLS_RECOVERY_BASE ?? `http://127.0.0.1:${server.address().port}`;
const name = process.env.HLS_TEST_BROWSER ?? 'chromium';
const browser = await { chromium, firefox, webkit }[name].launch(
  name === 'chromium'
    ? { args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] }
    : {},
);
try {
  for (const transport of ['fetch', 'xhr'])
    for (const mode of [
      'ts',
      'fmp4',
      'range',
      'implicit',
      'encrypted',
      'ts-range',
      'ts-implicit',
      'ts-encrypted',
      'live',
      'hevc',
      'av1',
      'gap',
      'multiple',
    ]) {
      const page = await browser.newPage({ ignoreHTTPSErrors: true });
      try {
        await page.goto(base + '/harness.html');
        const results = await page.evaluate(
          async ({ base, mode, transport }) => {
            const { ThePlayer } = await import('/player.js');
            const player = new ThePlayer(document.querySelector('video'));
            const errors = [];
            player.addEventListener('error', (e) =>
              errors.push(String(e.detail)),
            );
            await player.load({
              protocol: 'hls',
              url:
                mode === 'live'
                  ? `${base}/scenario/iframe-${transport}-${Date.now()}/iframes-live/master.m3u8`
                  : `${base}/fixture/iframes/${mode}-master.m3u8`,
              network: { transport },
            });
            if (mode === 'gap' || mode === 'multiple') {
              let result, failure;
              try {
                result = await player.getThumbnail(0.5);
              } catch (error) {
                failure = String(error);
              }
              if (mode === 'gap' && (result || failure))
                throw new Error('GAP must return no preview');
              if (
                mode === 'multiple' &&
                !failure?.includes('one independently decodable picture')
              )
                throw new Error('Multiple pictures not rejected: ' + failure);
              await new Promise((r) => setTimeout(r, 300));
              if (document.querySelector('video').currentTime <= 0)
                throw new Error('Optional preview broke playback');
              await player.destroy();
              return { optional: true, errors };
            }
            const values = [];
            for (const time of mode === 'live'
              ? [9.5, 13.5]
              : [0.5, 2.5, 4.5]) {
              if (mode === 'live' && time === 13.5)
                await new Promise((r) => setTimeout(r, 4200));
              let item;
              try {
                item = await player.getThumbnail(time);
              } catch (error) {
                if (
                  ['hevc', 'av1'].includes(mode) &&
                  String(error).includes('Unsupported preview decoder')
                ) {
                  await player.destroy();
                  return { unsupported: String(error), errors };
                }
                throw error;
              }
              if (!item) throw new Error('Missing I-frame preview');
              const img = new Image();
              img.src = item.url;
              await img.decode();
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const c = canvas.getContext('2d');
              c.drawImage(img, 0, 0);
              values.push({
                time: item.time,
                end: item.end,
                width: item.width,
                height: item.height,
                pixel: [...c.getImageData(100, 60, 1, 1).data],
              });
              if ((await player.getThumbnail(time)).url !== item.url)
                throw new Error('Preview cache not reused');
            }
            if (mode !== 'live' && (await player.getThumbnail(6)))
              throw new Error('Preview beyond playlist');
            await player.destroy();
            return { values, errors };
          },
          { base, mode, transport },
        );
        assert.deepEqual(results.errors, []);
        if (results.optional) {
          console.log(
            'PASS optional I-frame failure isolation',
            name,
            transport,
            mode,
          );
          continue;
        }
        if (results.unsupported) {
          console.log(
            'PASS explicit unavailable preview decoder',
            name,
            transport,
            mode,
            results.unsupported,
          );
          continue;
        }
        for (const [i, item] of results.values.entries()) {
          assert.equal(item.time, mode === 'live' ? 8 + i * 4 : i * 2);
          assert.equal(item.end, mode === 'live' ? 12 + i * 4 : i * 2 + 2);
          assert.equal(item.width, 320);
          assert.equal(item.height, 180);
          for (let component = 0; component < 3; component++)
            assert.ok(
              Math.abs(
                item.pixel[component] -
                  (component === (mode === 'live' ? (i + 2) % 3 : i) ? 255 : 0),
              ) < 40,
              JSON.stringify(item),
            );
        }
        console.log(
          'PASS decoded I-frame preview, timing and cache',
          name,
          transport,
          mode,
        );
      } finally {
        await page.close();
      }
    }
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
