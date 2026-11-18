import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
export function dashServer() {
  const root =
    process.env.THEPLAYER_DASH_FIXTURES ??
    path.join(os.tmpdir(), 'theplayer-dash-fixtures');
  const dist =
    process.env.THEPLAYER_DIST ??
    fileURLToPath(new URL('../../dist/', import.meta.url));
  const requests = [];
  const controls = {
    manifestFailures: 0,
    mediaFailures: 0,
    mediaDelayMs: 0,
    mediaFailureResponses: 0,
    status: 503,
    finish: false,
    patch: false,
    badPatch: 0,
    removeVideo: false,
    replacePeriod: false,
    depth: 12,
    chunkResponsesClosed: 0,
  };
  const epochs = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (url.pathname === '/harness.html') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><div><video muted></video></div>');
        return;
      }
      if (url.pathname === '/redirect.mpd') {
        res.writeHead(302, { Location: '/dash/timeline.mpd' });
        res.end();
        return;
      }
      if (url.pathname === '/dash/patch.mpp') {
        if (controls.badPatch > 0) {
          controls.badPatch--;
          res.writeHead(404);
          res.end();
          return;
        }
        const previous = url.searchParams.get('publish');
        const next = new Date(
          Math.max(Date.now(), Date.parse(previous) + 1),
        ).toISOString();
        const location = `/dash/patch.mpp?publish=${encodeURIComponent(next)}`;
        res.setHeader('Content-Type', 'application/dash-patch+xml');
        res.end(
          `<Patch xmlns="urn:mpeg:dash:schema:mpd-patch:2020" mpdId="dash-fixture" originalPublishTime="${previous}" publishTime="${next}"><replace sel="/MPD/@publishTime">${next}</replace><replace sel="/MPD/PatchLocation"><PatchLocation ttl="60">${location}</PatchLocation></replace></Patch>`,
        );
        return;
      }
      if (url.pathname.startsWith('/dash/') && url.pathname.endsWith('.mpd')) {
        if (controls.manifestFailures > 0) {
          controls.manifestFailures--;
          res.writeHead(controls.status);
          res.end();
          return;
        }
        let body = await readFile(path.join(root, 'timeline.mpd'), 'utf8');
        const mode = path.basename(url.pathname);
        if (mode === 'number.mpd')
          body = body.replace(
            /<SegmentTemplate([^>]*)>[\s\S]*?<\/SegmentTemplate>/g,
            (_, attrs) =>
              `<SegmentTemplate${attrs} duration="${Number(/timescale="(\d+)"/.exec(attrs)[1]) * 2}"/>`,
          );
        if (mode === 'list.mpd')
          body = body.replace(
            /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>/g,
            (_, attrs, content) => {
              const id = /\bid="([^"]+)"/.exec(attrs)[1];
              return `<Representation${attrs}>${content.replace(/<SegmentTemplate([^>]*)>([\s\S]*?)<\/SegmentTemplate>/, (_, a, timeline) => `<SegmentList${a.replace(/\s+(initialization|media)="[^"]*"/g, '')}><Initialization sourceURL="init-${id}.mp4"/>${timeline}${Array.from({ length: 12 }, (_, i) => `<SegmentURL media="segment-${id}-${String(i + 1).padStart(5, '0')}.m4s"/>`).join('')}</SegmentList>`)}</Representation>`;
            },
          );
        if (/^(cenc|cbcs)(-constant|-rotation)?\.mpd$/.test(mode)) {
          const scheme = mode.slice(0, -4);
          body = body.replace(
            /<Representation id="1"[\s\S]*?<\/Representation>/,
            '',
          );
          body = body.replace(
            /<Representation id="0"([^>]*)>[\s\S]*?<\/Representation>/,
            (_, attributes) =>
              `<Representation id="0"${attributes}><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="${scheme.startsWith('cbcs') ? 'cbcs' : 'cenc'}"/><SegmentTemplate timescale="1000" duration="2000" startNumber="0" initialization="${scheme}/init.mp4" media="${scheme}/segment$Number%02d$.m4s"/></Representation>`,
          );
          if (scheme.endsWith('-rotation')) {
            const contents = /<Period[^>]*>([\s\S]*?)<\/Period>/.exec(body)[1];
            const first = contents.replaceAll(
              `${scheme}/`,
              `${scheme.split('-')[0]}/`,
            );
            const second = contents.replaceAll(
              `${scheme}/`,
              `${scheme.split('-')[0]}-key2/`,
            );
            body = body.replace(
              /<Period[^>]*>[\s\S]*?<\/Period>/,
              `<Period id="key-one" start="PT0S" duration="PT12S">${first}</Period><Period id="key-two" start="PT12S" duration="PT12S">${second}</Period>`,
            );
          }
        }
        if (mode === 'text.mpd') {
          const adaptations = ['vtt', 'ttml', 'wvtt', 'stpp']
            .map((format) => {
              const mp4 = ['wvtt', 'stpp'].includes(format);
              const mime = mp4
                ? 'application/mp4'
                : format === 'vtt'
                  ? 'text/vtt'
                  : 'application/ttml+xml';
              const addressing = mp4
                ? `<SegmentTemplate timescale="1000" startNumber="0" initialization="${format}/init.mp4" media="${format}/segment$Number$.m4s"><SegmentTimeline><S t="0" d="2000" r="8"/></SegmentTimeline></SegmentTemplate>`
                : `<BaseURL>captions.${format}</BaseURL>`;
              return `<AdaptationSet id="${format}" contentType="text" lang="en" mimeType="${mime}"><Label>${format}</Label><Representation id="${format}" bandwidth="1000" codecs="${mp4 ? format : ''}">${addressing}</Representation></AdaptationSet>`;
            })
            .join('');
          body = body.replace('</Period>', adaptations + '</Period>');
        }
        if (mode === 'audio.mpd')
          body = body.replace(
            /<AdaptationSet id="0"[\s\S]*?<\/AdaptationSet>/,
            '',
          );
        if (mode === 'periods.mpd') {
          const content = /<Period[^>]*>([\s\S]*?)<\/Period>/.exec(body)[1];
          body = body.replace(
            /<Period[^>]*>[\s\S]*?<\/Period>/,
            `<Period id="first" start="PT0S" duration="PT12S">${content}</Period><Period id="second" start="PT12S" duration="PT12S">${content}</Period>`,
          );
        }
        if (mode === 'pto.mpd') {
          body = body.replace(
            'mediaPresentationDuration="PT24.0S"',
            'mediaPresentationDuration="PT20S"',
          );
          body = body.replace(
            /<SegmentTemplate timescale="(\d+)"/g,
            (_, scale) =>
              `<SegmentTemplate presentationTimeOffset="${Number(scale) * 4}" timescale="${scale}"`,
          );
        }
        if ((mode === 'live.mpd' || mode === 'll.mpd') && !controls.finish) {
          const session = url.searchParams.get('session') ?? '';
          if (!epochs.has(session)) epochs.set(session, Date.now() - 8000);
          const epoch = epochs.get(session);
          body = body
            .replace(
              'type="static"',
              `type="dynamic" availabilityStartTime="${new Date(epoch).toISOString()}" publishTime="${new Date().toISOString()}" minimumUpdatePeriod="PT0.5S" suggestedPresentationDelay="PT4S" timeShiftBufferDepth="PT${controls.depth}S"`,
            )
            .replace(/mediaPresentationDuration="[^"]+"/, '');
        }
        if (controls.patch && mode === 'live.mpd') {
          const publish = /publishTime="([^"]+)"/.exec(body)[1];
          body = body
            .replace('<MPD ', '<MPD id="dash-fixture" ')
            .replace(
              '<Period',
              `<PatchLocation ttl="60">/dash/patch.mpp?publish=${encodeURIComponent(publish)}</PatchLocation><Period`,
            );
        }
        if (mode === 'll.mpd') {
          body = body.replace(
            'suggestedPresentationDelay="PT4S"',
            'suggestedPresentationDelay="PT3S"',
          );
          body = body.replace(
            '<Period',
            '<ServiceDescription id="0"><Latency target="3000" min="2000" max="5000"/><PlaybackRate min="0.97" max="1.03"/></ServiceDescription><Period',
          );
          body = body.replace(
            /<SegmentTemplate([^>]*)>[\s\S]*?<\/SegmentTemplate>/g,
            (_, attrs) =>
              `<SegmentTemplate${attrs.replace(/ media="[^"]*"/, ' media="ll-$RepresentationID$-$Number$.m4s"')} duration="${Number(/timescale="(\d+)"/.exec(attrs)[1]) * 4}" availabilityTimeOffset="2" availabilityTimeComplete="false"/>`,
          );
        }
        if (controls.removeVideo)
          body = body.replace(
            /<Representation id="1"[\s\S]*?<\/Representation>/,
            '',
          );
        if (controls.replacePeriod)
          body = body
            .replace(/<Period[^>]*>/, '<Period id="replacement" start="PT6S">')
            .replace(
              /<SegmentTemplate timescale="(\d+)"/g,
              (_, scale) =>
                `<SegmentTemplate presentationTimeOffset="${Number(scale) * 6}" timescale="${scale}"`,
            );
        res.setHeader('Content-Type', 'application/dash+xml');
        res.end(body);
        return;
      }
      const chunked = /^\/dash\/ll-(\d+)-(\d+)\.m4s$/.exec(url.pathname);
      if (chunked) {
        const first = (Number(chunked[2]) - 1) * 2 + 1;
        const segment = (n) =>
          readFile(
            path.join(
              root,
              `segment-${chunked[1]}-${String(n).padStart(5, '0')}.m4s`,
            ),
          );
        const [a, b] = await Promise.all([segment(first), segment(first + 1)]);
        res.setHeader('Content-Type', 'video/mp4');
        res.write(a.subarray(0, 17));
        res.write(a.subarray(17));
        await new Promise((r) => setTimeout(r, 2500));
        if (!res.destroyed) res.write(b);
        await new Promise((r) => setTimeout(r, 100));
        controls.chunkResponsesClosed++;
        res.end();
        return;
      }
      const directory = url.pathname.startsWith('/dash/') ? root : dist;
      const relative = url.pathname.startsWith('/dash/')
        ? url.pathname.slice(6)
        : url.pathname.slice(1);
      const file = path.resolve(directory, relative);
      if (!file.startsWith(path.resolve(directory) + path.sep)) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (file.endsWith('.m4s') && controls.mediaFailures > 0) {
        controls.mediaFailures--;
        if (controls.mediaDelayMs)
          await new Promise((r) => setTimeout(r, controls.mediaDelayMs));
        controls.mediaFailureResponses++;
        res.writeHead(controls.status);
        res.end();
        return;
      }
      const bytes = await readFile(file);
      res.setHeader(
        'Content-Type',
        {
          '.js': 'text/javascript',
          '.html': 'text/html',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.json': 'application/json',
        }[path.extname(file)] ?? 'video/mp4',
      );
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]),
          end = Math.min(Number(range[2]), bytes.length - 1);
        if (start > end) {
          res.writeHead(416);
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
          'Access-Control-Expose-Headers': 'Content-Range',
        });
        res.end(bytes.subarray(start, end + 1));
      } else res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return { server, requests, controls };
}
