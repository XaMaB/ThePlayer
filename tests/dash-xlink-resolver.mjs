import { chromium } from 'playwright';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents: "export * from './xlink.ts'; export * from './mpd.ts';",
    resolveDir: new URL('../src/engines/dash/', import.meta.url).pathname,
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'DashTest',
});
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  console.log(
    await page.evaluate(async () => {
      const { RemoteElements, parseMpd } = DashTest;
      const assert = (v, m) => {
        if (!v) throw new Error(m);
      };
      const ns = 'urn:mpeg:dash:schema:mpd:2011';
      const wrap = (c) =>
        `<MPD xmlns="${ns}" xmlns:xlink="http://www.w3.org/1999/xlink" mediaPresentationDuration="PT20S">${c}</MPD>`;
      const media =
        '<AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="$Number$.m4s" initialization="init.mp4"/><Representation id="v" bandwidth="100000" codecs="avc1.42c01e"/></AdaptationSet>';
      let calls = 0;
      let remote = `<Period duration="PT20S">${media}</Period>`;
      const resolver = new RemoteElements({
        signal: new AbortController().signal,
        get: async () => {
          calls++;
          return {
            url: 'https://cdn.example/redirect/remote.xml',
            data: new TextEncoder().encode(remote),
          };
        },
      });
      const url = 'https://origin.example/main.mpd';
      const load = wrap(
        '<Period xlink:href="remote.xml" xlink:actuate="onLoad"/>',
      );
      let parsed = parseMpd(await resolver.resolve(load, url), url);
      assert(
        parsed.periods[0].adaptations[0].representations[0].baseUrls[0] ===
          'https://cdn.example/redirect/remote.xml',
        'Redirect base preserved',
      );
      await resolver.resolve(load, url);
      assert(calls === 2, 'onLoad resolves every manifest load');
      const request = wrap(
        `<Period duration="PT10S">${media}</Period><Period start="PT10S" duration="PT10S" xlink:href="future"><AdaptationSet xlink:href="unused" xlink:actuate="onLoad"/></Period>`,
      );
      parsed = parseMpd(await resolver.resolve(request, url, 1), url);
      assert(
        calls === 2 &&
          parsed.periods[1].remote &&
          !parsed.periods[1].adaptations.length,
        'Future defaults remain deferred',
      );
      remote = `<Period start="PT10S" duration="PT10S">${media}</Period>`;
      await resolver.resolve(request, url, 12);
      await resolver.resolve(request, url, 13);
      assert(calls === 3, 'onRequest decision retained');
      remote = `<Period duration="PT10S">${media}</Period><Period start="PT10S" duration="PT10S">${media}</Period>`;
      parsed = parseMpd(await resolver.resolve(load, url), url);
      assert(
        parsed.periods.length === 2 && parsed.periods[1].start === 10,
        'Multiple sibling remote Periods',
      );
      remote = '<not-xml';
      const fallback = wrap(
        `<Period duration="PT20S" xlink:href="broken" xlink:actuate="onLoad">${media}</Period>`,
      );
      parsed = parseMpd(await resolver.resolve(fallback, url), url);
      assert(
        parsed.periods[0].adaptations.length === 1 &&
          resolver.diagnostics.fallbacks === 1,
        'Invalid remote uses local default',
      );
      const zero = wrap(
        `<Period duration="PT20S">${media}</Period><Period xlink:href="urn:mpeg:dash:resolve-to-zero:2013"/>`,
      );
      const before = calls;
      parsed = parseMpd(await resolver.resolve(zero, url), url);
      assert(
        parsed.periods.length === 1 && calls === before,
        'Resolve-to-zero has no request',
      );
      remote = '<Period xlink:href="cycle.xml" xlink:actuate="onLoad"/>';
      let rejected = false;
      try {
        await resolver.resolve(load, url);
      } catch (e) {
        rejected = /nesting limit/.test(e.message);
      }
      assert(rejected, 'Recursive links bounded');
      return 'XLink redirect, refresh, deferred defaults, retained decisions, siblings, fallback, zero and cycles PASS';
    }),
  );
} finally {
  await browser.close();
}
