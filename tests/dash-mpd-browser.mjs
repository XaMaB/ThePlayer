import { chromium } from 'playwright';
import { build } from 'esbuild';
const bundle = await build({
  stdin: {
    contents: "export * from './mpd.ts'; export * from './segments.ts';",
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
  const cases = await page.evaluate(() => {
    const { parseMpd, segmentReferences } = DashTest;
    const results = [];
    const base = 'https://cdn.example/redirected/manifest.mpd?auth=token';
    const wrap = (content, attrs = '') =>
      `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT20S" ${attrs}>${content}</MPD>`;
    const rep =
      '<Representation id="v1" bandwidth="200000" codecs="avc1.42c01e" mimeType="video/mp4"/>';
    const template =
      '<SegmentTemplate timescale="1000" duration="2000" initialization="$RepresentationID$-init.mp4" media="$Number%04d$.m4s"/>';
    const expect = (value, message) => {
      if (!value) throw new Error(message);
    };
    const rejects = (xml, message) => {
      let rejected = false;
      try {
        parseMpd(xml, base);
      } catch {
        rejected = true;
      }
      expect(rejected, message);
    };
    const inherited = parseMpd(
      wrap(
        `<BaseURL>media/</BaseURL>${template}<Period><BaseURL>period/</BaseURL><AdaptationSet id="v">${rep}</AdaptationSet></Period>`,
      ),
      base,
    );
    const r = inherited.periods[0].adaptations[0].representations[0];
    expect(
      r.baseUrls[0] === 'https://cdn.example/redirected/media/period/',
      'Redirect-relative BaseURL inheritance',
    );
    expect(
      segmentReferences(r, inherited.periods[0], 0, 2)[0].url ===
        'https://cdn.example/redirected/media/period/0001.m4s',
      'Template inheritance',
    );
    results.push('nested BaseURL and segment inheritance');
    const periods = parseMpd(
      wrap(
        `<Period id="a" duration="PT8S"><AdaptationSet>${template}${rep}</AdaptationSet></Period><Period id="b"><AdaptationSet>${template}${rep}</AdaptationSet></Period>`,
      ),
      base,
    );
    expect(
      periods.periods[1].start === 8 && periods.periods[1].duration === 12,
      'Implicit Period timing',
    );
    results.push('implicit Period start/duration');
    const overrides = parseMpd(
      wrap(
        `<Period><AdaptationSet mimeType="video/mp4" codecs="avc1.42c01e">${template}<Representation id="v" bandwidth="1"><SegmentTemplate timescale="48000" duration="96000" startNumber="7"/></Representation></AdaptationSet></Period>`,
      ),
      base,
    );
    const a = overrides.periods[0].adaptations[0].representations[0].address;
    expect(
      a.timescale === 48000 &&
        a.duration === 96000n &&
        a.startNumber === 7n &&
        a.initialization,
      'Inherited attributes overridden individually',
    );
    results.push('representation overrides');
    const dynamic = parseMpd(
      wrap(
        `<Period><AdaptationSet>${template}${rep}</AdaptationSet></Period>`,
        'type="dynamic" availabilityStartTime="2026-01-01T00:00:00Z" minimumUpdatePeriod="PT0.5S" timeShiftBufferDepth="PT60S"',
      ),
      base,
    );
    expect(
      dynamic.live &&
        dynamic.minimumUpdatePeriod === 0.5 &&
        dynamic.timeShiftBufferDepth === 60,
      'Dynamic attributes',
    );
    results.push('dynamic timing attributes');
    rejects('<MPD/>', 'Namespaces are required');
    rejects(wrap('<Period>'), 'Malformed XML');
    rejects(
      '<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
        wrap('<Period/>'),
      'No DTD/entity expansion',
    );
    rejects(wrap('<Period/>', 'type="dynamic"'), 'Live AST required');
    rejects(
      wrap(
        `<Period><AdaptationSet>${template}<SegmentList/>${rep}</AdaptationSet></Period>`,
      ),
      'Conflicting addressing',
    );
    rejects(
      wrap(
        `<Period><AdaptationSet><BaseURL>javascript:alert(1)</BaseURL>${template}${rep}</AdaptationSet></Period>`,
      ),
      'HTTP(S) only',
    );
    rejects(
      wrap(
        `<Period><AdaptationSet><SegmentTemplate timescale="0"/>${rep}</AdaptationSet></Period>`,
      ),
      'Positive timescale',
    );
    rejects(
      wrap(
        '<Period xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.com/period"/>',
      ),
      'Unsupported XLink explicit',
    );
    for (const attribute of [
      'eptDelta="9223372036854775808"',
      'availabilityTimeComplete="maybe"',
    ])
      rejects(
        wrap(
          `<Period><AdaptationSet>${template.replace('timescale="1000"', attribute)}${rep}</AdaptationSet></Period>`,
        ),
        'Invalid addressing attributes',
      );
    rejects(
      wrap(
        `<Period><AdaptationSet><EssentialProperty schemeIdUri="urn:unknown"/>${template}${rep}</AdaptationSet></Period>`,
      ),
      'Unknown required profile',
    );
    rejects(
      wrap(
        `<Period><AdaptationSet>${template}${rep.replace('bandwidth="200000"', 'bandwidth="200000" frameRate="1/0"')}</AdaptationSet></Period>`,
      ),
      'Invalid frame rate',
    );
    results.push(
      'malformed XML, namespace, unsafe URLs, timing and unsupported XLink rejection',
    );
    return results;
  });
  for (const item of cases) console.log('MPD PASS', item);
} finally {
  await browser.close();
}
