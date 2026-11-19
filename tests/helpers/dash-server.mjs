import { loopMedia } from './dash-loop-media.mjs';
import { indexedMedia } from './dash-index.mjs';
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
  const indexed = new Map();
  const getIndexed = (id) => {
    if (!indexed.has(id)) indexed.set(id, indexedMedia(root, id));
    return indexed.get(id);
  };
  const controls = {
    manifestFailures: 0,
    mediaFailures: 0,
    mediaDelayMs: 0,
    mediaFailureResponses: 0,
    status: 503,
    finish: false,
    clockShift: 0,
    patch: false,
    badPatch: 0,
    removeVideo: false,
    removeAudio: false,
    replacePeriod: false,
    depth: 12,
    chunkResponsesClosed: 0,
    chunkPaceMs: 0,
    chunkDisconnects: 0,
    producerTime: 0,
    inbandProducer: false,
    steeringPriority: ['good', 'bad'],
    steeringStatus: 200,
    steeringClones: undefined,
    cloneRequests: 0,
    steeringRequests: [],
    telemetry: [],
  };
  const epochs = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push(url.pathname);
    if (url.searchParams.get('pathway') === 'clone') controls.cloneRequests++;
    if (url.searchParams.has('CMCD') || req.headers['cmcd-session'])
      controls.telemetry.push({
        path: url.pathname,
        query: url.searchParams.get('CMCD'),
        session: req.headers['cmcd-session'],
        object: req.headers['cmcd-object'],
        request: req.headers['cmcd-request'],
      });
    res.setHeader('CMSD-Dynamic', 'testcdn;etp=5000');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (url.pathname === '/harness.html') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><div><video muted></video></div>');
        return;
      }
      if (/^\/dash\/indexed-\d+\.mp4$/.test(url.pathname)) {
        const id = /indexed-(\d+)/.exec(url.pathname)[1];
        const { data } = await getIndexed(id);
        const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
        if (!range) {
          res.end(data);
          return;
        }
        const start = Number(range[1]),
          end = Number(range[2]);
        if (end >= data.length || end < start) {
          res.writeHead(416);
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${data.length}`,
          'Content-Type': 'video/mp4',
        });
        res.end(data.subarray(start, end + 1));
        return;
      }
      if (url.pathname === '/steering.json') {
        controls.steeringRequests.push(url.search);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(controls.steeringStatus);
        res.end(
          JSON.stringify({
            VERSION: 1,
            TTL: 1,
            'PATHWAY-PRIORITY': controls.steeringPriority,
            ...(controls.steeringClones
              ? { 'PATHWAY-CLONES': controls.steeringClones }
              : {}),
          }),
        );
        return;
      }
      if (/^\/profiles\/(av1|hevc|ac3|eac3)\/[^/]+$/.test(url.pathname)) {
        const data = await readFile(path.join(root, url.pathname));
        res.setHeader(
          'Content-Type',
          url.pathname.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4',
        );
        res.end(data);
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
      if (
        url.pathname === '/remote/period.xml' ||
        url.pathname === '/remote/redirect'
      ) {
        if (url.pathname.endsWith('/redirect')) {
          res.writeHead(302, { Location: '/remote/period.xml' });
          res.end();
          return;
        }
        const xml = await readFile(path.join(root, 'timeline.mpd'), 'utf8');
        const contents = /<Period[^>]*>([\s\S]*?)<\/Period>/.exec(xml)[1];
        const start = url.searchParams.get('start') ?? '0';
        res.setHeader('Content-Type', 'application/xml');
        res.end(
          `<Period xmlns="urn:mpeg:dash:schema:mpd:2011" id="remote-${start}" start="PT${start}S" duration="PT${24 - Number(start)}S"><BaseURL>/dash/</BaseURL>${contents}</Period>`,
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
        if (mode === 'views.mpd') {
          body = body.replace(
            /(<AdaptationSet id="2"[^>]*>)/,
            '$1<Role schemeIdUri="urn:mpeg:dash:role:2011" value="description"/><Accessibility schemeIdUri="urn:test:purpose" value="description"/>',
          );
          body = body.replace(
            /<AdaptationSet id="0"([\s\S]*?)<\/AdaptationSet>/,
            (whole, content) => {
              const first =
                /<Representation id="0"[\s\S]*?<\/Representation>/.exec(
                  content,
                )[0];
              const second =
                /<Representation id="1"[\s\S]*?<\/Representation>/.exec(
                  content,
                )[0];
              return `<AdaptationSet id="front" contentType="video" mimeType="video/mp4"><Label>Front camera</Label>${first}</AdaptationSet><AdaptationSet id="side" contentType="video" mimeType="video/mp4"><Label>Side camera</Label>${second}</AdaptationSet>`;
            },
          );
        }
        if (mode === 'thumbnails.mpd') {
          body = body.replace(
            '</Period>',
            '<AdaptationSet id="images" contentType="image" mimeType="image/jpeg"><SegmentTemplate duration="24" media="thumbnails.jpg"/><Representation id="sheet" bandwidth="10000" width="320" height="180"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/thumbnail_tile" value="2x2"/></Representation></AdaptationSet></Period>',
          );
        }
        if (mode === 'steering.mpd') {
          body = body.replace(
            '<Period',
            '<BaseURL serviceLocation="bad">/missing/</BaseURL><BaseURL serviceLocation="good">/dash/</BaseURL><Period',
          );
          body = body.replace(
            '</MPD>',
            '<ContentSteering defaultServiceLocation="bad" queryBeforeStart="true">/steering.json</ContentSteering></MPD>',
          );
        }
        if (mode === 'hierarchical.mpd') {
          for (let id = 0; id < 4; id++) {
            const index = await getIndexed(String(id));
            const pattern = new RegExp(
              `(<Representation id="${id}"[^>]*>)([\\s\\S]*?)(</Representation>)`,
            );
            body = body.replace(
              pattern,
              (_, open, content, close) =>
                open +
                content.replace(
                  /<SegmentTemplate[\s\S]*?<\/SegmentTemplate>/,
                  `<BaseURL>indexed-${id}.mp4</BaseURL><SegmentBase indexRange="${index.indexStart}-${index.indexEnd}"><Initialization range="0-${index.initEnd}"/></SegmentBase>`,
                ) +
                close,
            );
          }
        }
        if (mode.startsWith('xlink-')) {
          const content = /<Period[^>]*>([\s\S]*?)<\/Period>/.exec(body)[1];
          const start = mode === 'xlink-request.mpd' ? 12 : 0;
          const href =
            mode === 'xlink-fallback.mpd'
              ? '/missing.xml'
              : mode === 'xlink-load.mpd'
                ? '/remote/redirect'
                : `/remote/period.xml?start=${start}`;
          const remote = `<Period xmlns:xlink="http://www.w3.org/1999/xlink" id="placeholder" start="PT${start}S" duration="PT${24 - start}S" xlink:href="${href}" xlink:actuate="${start ? 'onRequest' : 'onLoad'}">${mode === 'xlink-fallback.mpd' ? content : ''}</Period>`;
          body = body.replace(
            /<Period[^>]*>[\s\S]*?<\/Period>/,
            `${start ? `<Period id="first" start="PT0S" duration="PT12S">${content}</Period>` : ''}${remote}`,
          );
        }
        if (mode === 'number.mpd' || mode === 'soak.mpd')
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
        if (mode === 'cea608.mpd' || mode === 'cea708.mpd') {
          const folder = mode === 'cea608.mpd' ? 'sei-mp4' : 'cea708-mp4';
          body = body.replace(
            /<Representation id="1"[\s\S]*?<\/Representation>/,
            '',
          );
          body = body.replace(
            /<Representation id="0"([^>]*)>[\s\S]*?<\/Representation>/,
            (_, attributes) =>
              `<Representation id="0"${attributes}><SegmentTemplate timescale="1000" duration="2000" startNumber="0" initialization="${folder}/init.mp4" media="${folder}/segment$Number%02d$.m4s"/></Representation>`,
          );
        }
        if (/^(cenc|cbcs)(-constant|-rotation|-seig)?\.mpd$/.test(mode)) {
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
        if (['text.mpd', 'text-periods.mpd', 'text-pto.mpd'].includes(mode)) {
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
        if (mode === 'metadata.mpd')
          body = body
            .replace(
              '</Period>',
              '<EventStream schemeIdUri="urn:test:manifest" timescale="1000"><Event id="cue" presentationTime="1000" duration="500" messageData="safe metadata"/></EventStream></Period>',
            )
            .replaceAll('media="segment-', 'media="meta-');
        if (mode === 'cdn.mpd')
          body = body.replace(
            '<Period',
            '<BaseURL>/missing/</BaseURL><BaseURL>/dash/</BaseURL><Period',
          );
        if (mode === 'audio.mpd')
          body = body.replace(
            /<AdaptationSet id="0"[\s\S]*?<\/AdaptationSet>/,
            '',
          );
        if (mode === 'periods.mpd' || mode === 'text-periods.mpd') {
          const content = /<Period[^>]*>([\s\S]*?)<\/Period>/.exec(body)[1];
          body = body.replace(
            /<Period[^>]*>[\s\S]*?<\/Period>/,
            `<Period id="first" start="PT0S" duration="PT12S">${content}</Period><Period id="second" start="PT12S" duration="PT12S">${content}</Period>`,
          );
        }
        if (mode === 'pto.mpd' || mode === 'text-pto.mpd') {
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
        if (
          ['live.mpd', 'll.mpd', 'll-soak.mpd', 'soak.mpd'].includes(mode) &&
          !controls.finish
        ) {
          const session = url.searchParams.get('session') ?? '';
          if (!epochs.has(session)) epochs.set(session, Date.now() - 8000);
          const epoch = epochs.get(session);
          body = body
            .replace(
              'type="static"',
              `type="dynamic" availabilityStartTime="${new Date(epoch + controls.clockShift).toISOString()}" publishTime="${new Date().toISOString()}" minimumUpdatePeriod="PT0.5S" suggestedPresentationDelay="PT4S" timeShiftBufferDepth="PT${controls.depth}S"`,
            )
            .replace(/mediaPresentationDuration="[^"]+"/, '');
        }
        if (mode === 'soak.mpd')
          body = body.replaceAll('media="segment-', 'media="loop-');
        if (controls.patch && mode === 'live.mpd') {
          const publish = /publishTime="([^"]+)"/.exec(body)[1];
          body = body
            .replace('<MPD ', '<MPD id="dash-fixture" ')
            .replace(
              '<Period',
              `<PatchLocation ttl="60">/dash/patch.mpp?publish=${encodeURIComponent(publish)}</PatchLocation><Period`,
            );
        }
        if (mode === 'll.mpd' || mode === 'll-soak.mpd') {
          controls.producerTime =
            (epochs.get(url.searchParams.get('session') ?? '') - 1000) / 1000;
          body = body.replace(
            /(<AdaptationSet[^>]*>)/g,
            `$1<ProducerReferenceTime id="7" type="encoder" inband="${controls.inbandProducer}" wallClockTime="${new Date(controls.producerTime * 1000).toISOString()}" presentationTime="0"/>`,
          );
          body = body.replace(
            'suggestedPresentationDelay="PT4S"',
            'suggestedPresentationDelay="PT3S"',
          );
          body = body.replace(
            '<Period',
            '<ServiceDescription id="0"><Latency referenceId="7" target="3000" min="2000" max="5000"/><PlaybackRate min="0.97" max="1.03"/></ServiceDescription><Period',
          );
          body = body.replace(
            /<SegmentTemplate([^>]*)>[\s\S]*?<\/SegmentTemplate>/g,
            (_, attrs) =>
              `<SegmentTemplate${attrs.replace(/ media="[^"]*"/, ' media="ll-$RepresentationID$-$Number$.m4s"')} duration="${Number(/timescale="(\d+)"/.exec(attrs)[1]) * 4}" availabilityTimeOffset="2" availabilityTimeComplete="false"/>`,
          );
        }
        if (mode === 'll-soak.mpd')
          body = body.replaceAll('media="ll-', 'media="ll-loop-');
        if (controls.removeAudio)
          body = body.replace(
            /<AdaptationSet id="[12]"[\s\S]*?<\/AdaptationSet>/g,
            '',
          );
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
      const loop = /^\/dash\/loop-(\d+)-(\d+)\.m4s$/.exec(url.pathname);
      if (loop) {
        if (controls.mediaFailures > 0) {
          controls.mediaFailures--;
          controls.mediaFailureResponses++;
          res.writeHead(controls.status);
          res.end();
          return;
        }
        const data = await loopMedia(root, loop[1], Number(loop[2]));
        res.setHeader('Content-Type', 'video/mp4');
        res.end(data);
        return;
      }
      const llLoop = /^\/dash\/ll-loop-(\d+)-(\d+)\.m4s$/.exec(url.pathname);
      if (llLoop) {
        if (controls.mediaFailures > 0) {
          controls.mediaFailures--;
          res.writeHead(503);
          res.end();
          return;
        }
        const number = Number(llLoop[2]);
        res.setHeader('Content-Type', 'video/mp4');
        for (let i = 0; i < 2; i++) {
          const deadline =
            epochs.get('') + ((number - 1) * 4 + (i + 1) * 2) * 1000;
          await new Promise((r) =>
            setTimeout(
              r,
              Math.max(0, deadline - Date.now()) + ((number + i) % 4) * 50,
            ),
          );
          if (res.destroyed) return;
          const data = await loopMedia(
            root,
            llLoop[1],
            (number - 1) * 2 + i + 1,
          );
          const split = Math.floor(data.length / 2);
          res.write(data.subarray(0, split));
          await new Promise((r) => setTimeout(r, 30));
          if (res.destroyed) return;
          res.write(data.subarray(split));
        }
        controls.chunkResponsesClosed++;
        res.end();
        return;
      }
      const metadata = /^\/dash\/meta-(\d+)-(\d+)\.m4s$/.exec(url.pathname);
      if (metadata) {
        const data = await readFile(
          path.join(root, `segment-${metadata[1]}-${metadata[2]}.m4s`),
        );
        const u32 = (n) => {
          const b = Buffer.alloc(4);
          b.writeUInt32BE(n);
          return b;
        };
        const body = Buffer.concat([
          Buffer.from([1, 0, 0, 0]),
          u32(1000),
          u32(0),
          u32(1000),
          u32(500),
          u32(7),
          Buffer.from('urn:test:fragment\0value\0payload'),
        ]);
        res.setHeader('Content-Type', 'video/mp4');
        res.end(
          Buffer.concat([
            u32(body.length + 8),
            Buffer.from('emsg'),
            body,
            data,
          ]),
        );
        return;
      }
      const chunked = /^\/dash\/ll-(\d+)-(\d+)\.m4s$/.exec(url.pathname);
      if (chunked) {
        const first = (Number(chunked[2]) - 1) * 2 + 1;
        const segment = async (n) => {
          const data = await readFile(
            path.join(
              root,
              `segment-${chunked[1]}-${String(n).padStart(5, '0')}.m4s`,
            ),
          );
          if (!controls.inbandProducer) return data;
          const prft = Buffer.alloc(32);
          prft.writeUInt32BE(32);
          prft.write('prft', 4);
          prft[8] = 1;
          prft.writeUInt32BE(1, 12);
          const ntp = controls.producerTime + 2208988800;
          prft.writeUInt32BE(Math.floor(ntp) % 2 ** 32, 16);
          prft.writeUInt32BE(Math.floor((ntp % 1) * 2 ** 32), 20);
          // time zero maps to the producer epoch independently of each fragment.
          return Buffer.concat([prft, data]);
        };
        const [a, b] = await Promise.all([segment(first), segment(first + 1)]);
        res.setHeader('Content-Type', 'video/mp4');
        const split = controls.chunkPaceMs ? Math.floor(a.length / 2) : 17;
        res.write(a.subarray(0, split));
        if (controls.chunkPaceMs)
          await new Promise((r) => setTimeout(r, controls.chunkPaceMs));
        res.write(a.subarray(split));
        if (controls.chunkDisconnects > 0) {
          controls.chunkDisconnects--;
          await new Promise((r) => setTimeout(r, 100));
          res.destroy();
          return;
        }
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
