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
    depth: 12,
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
        if (mode === 'live.mpd' && !controls.finish) {
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
        res.setHeader('Content-Type', 'application/dash+xml');
        res.end(body);
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
