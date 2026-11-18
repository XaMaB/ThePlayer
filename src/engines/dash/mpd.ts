import type {
  Adaptation,
  Manifest,
  Period,
  Protection,
  Representation,
  SegmentAddress,
} from './model';
const ns = 'urn:mpeg:dash:schema:mpd:2011';
const children = (element: Element, name: string) =>
  Array.from(element.children).filter(
    (e) => e.localName === name && e.namespaceURI === ns,
  );
const one = (element: Element, name: string) => children(element, name)[0];
const attr = (element: Element | undefined, name: string) =>
  element?.getAttribute(name) ?? undefined;
export function duration(value: string | undefined): number | undefined {
  if (value === undefined) return;
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!m || !m.slice(1).some(Boolean)) throw new Error('Invalid DASH duration');
  const seconds =
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0);
  if (!Number.isFinite(seconds))
    throw new Error('DASH duration exceeds numeric range');
  return seconds;
}
function decimal(value: string | undefined, fallback: number, minimum = 0) {
  if (value === undefined) return fallback;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    throw new Error('Invalid DASH numeric attribute');
  const result = Number(value);
  if (!Number.isFinite(result) || result < minimum)
    throw new Error('Invalid DASH numeric range');
  return result;
}
function integer(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || value.length > 20)
    throw new Error('Invalid DASH unsigned integer');
  const result = BigInt(value);
  if (result > 0xffffffffffffffffn)
    throw new Error('DASH integer exceeds 64 bits');
  return result;
}
function signedInteger(value: string | undefined, fallback: bigint) {
  if (value === undefined) return fallback;
  if (!/^[+-]?\d{1,19}$/.test(value))
    throw new Error('Invalid DASH signed integer');
  const result = BigInt(value);
  if (result < -(1n << 63n) || result >= 1n << 63n)
    throw new Error('DASH signed integer exceeds 64 bits');
  return result;
}
function boolean(value: string | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  if (!['true', 'false', '1', '0'].includes(value))
    throw new Error('Invalid DASH boolean');
  return value === 'true' || value === '1';
}
function date(value: string | undefined) {
  if (value === undefined) return;
  const result = Date.parse(value);
  if (!Number.isFinite(result) || !/(Z|[+-]\d\d:\d\d)$/.test(value))
    throw new Error('Invalid DASH UTC date');
  return result / 1000;
}
export function resolveUrl(value: string, base: string) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('DASH resources require HTTP(S)');
  return url.href;
}
function bases(element: Element, parent: string[]) {
  const urls = children(element, 'BaseURL');
  if (!urls.length) return parent;
  if (urls.length * parent.length > 32)
    throw new Error('Too many DASH BaseURL alternatives');
  return parent.flatMap((base) =>
    urls.map((e) => resolveUrl(e.textContent!.trim(), base)),
  );
}
function range(value: string | undefined) {
  if (!value) return;
  const m = /^(\d+)-(\d+)$/.exec(value);
  if (!m) throw new Error('Invalid DASH byte range');
  const offset = Number(m[1]),
    end = Number(m[2]);
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(end) ||
    end < offset
  )
    throw new Error('Invalid DASH byte range');
  return { offset, length: end - offset + 1 };
}
function address(
  element: Element,
  parent?: SegmentAddress,
): SegmentAddress | undefined {
  const declarations = [
    'SegmentTemplate',
    'SegmentList',
    'SegmentBase',
  ].flatMap((name) => children(element, name));
  if (declarations.length > 1)
    throw new Error('Conflicting DASH segment addressing');
  const e = declarations[0];
  if (!e) return parent;
  const kind =
    e.localName === 'SegmentTemplate'
      ? 'template'
      : e.localName === 'SegmentList'
        ? 'list'
        : 'base';
  const inherited = parent?.kind === kind ? parent : undefined;
  const timescale = decimal(attr(e, 'timescale'), inherited?.timescale ?? 1, 1);
  if (!Number.isSafeInteger(timescale))
    throw new Error('Invalid DASH timescale');
  const out: SegmentAddress = {
    ...inherited,
    kind,
    timescale,
    presentationTimeOffset: integer(
      attr(e, 'presentationTimeOffset'),
      inherited?.presentationTimeOffset ?? 0n,
    ),
    startNumber: integer(attr(e, 'startNumber'), inherited?.startNumber ?? 1n),
    eptDelta: signedInteger(attr(e, 'eptDelta'), inherited?.eptDelta ?? 0n),
    availabilityTimeOffset:
      attr(e, 'availabilityTimeOffset') === 'INF'
        ? Infinity
        : decimal(
            attr(e, 'availabilityTimeOffset'),
            inherited?.availabilityTimeOffset ?? 0,
            -Infinity,
          ),
    availabilityTimeComplete: boolean(
      attr(e, 'availabilityTimeComplete'),
      inherited?.availabilityTimeComplete ?? true,
    ),
  };
  if (attr(e, 'duration') !== undefined) {
    out.duration = integer(attr(e, 'duration'), 0n);
    if (!out.duration)
      throw new Error('DASH segment duration must be positive');
  }
  if (attr(e, 'media') !== undefined) out.media = attr(e, 'media');
  if (attr(e, 'initialization') !== undefined)
    out.initialization = attr(e, 'initialization');
  if (attr(e, 'indexRange') !== undefined)
    out.indexRange = range(attr(e, 'indexRange'));
  const init = one(e, 'Initialization');
  if (init) {
    out.initialization = attr(init, 'sourceURL') ?? '';
    out.initializationRange = range(attr(init, 'range'));
  }
  const timeline = one(e, 'SegmentTimeline');
  if (timeline) {
    const entries = children(timeline, 'S');
    if (!entries.length || entries.length > 100000)
      throw new Error('Invalid DASH SegmentTimeline size');
    out.timeline = entries.map((s) => {
      const d = integer(attr(s, 'd'), 0n);
      const repeat = decimal(attr(s, 'r'), 0, -1);
      if (!d || !Number.isSafeInteger(repeat))
        throw new Error('Invalid DASH timeline duration/repeat');
      return {
        time:
          attr(s, 't') === undefined ? undefined : integer(attr(s, 't'), 0n),
        duration: d,
        repeat,
      };
    });
  }
  const urls = children(e, 'SegmentURL');
  if (urls.length)
    out.urls = urls.map((s) => ({
      media: attr(s, 'media') ?? '',
      range: range(attr(s, 'mediaRange')),
    }));
  return out;
}
function protections(element: Element): Protection[] {
  return children(element, 'ContentProtection').map((e) => ({
    scheme: attr(e, 'schemeIdUri') ?? '',
    value: attr(e, 'value'),
    keyIds: (e.getAttributeNS('urn:mpeg:cenc:2013', 'default_KID') ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean),
    pssh: Array.from(e.children)
      .filter(
        (c) =>
          c.namespaceURI === 'urn:mpeg:cenc:2013' && c.localName === 'pssh',
      )
      .map((c) => {
        const value = (c.textContent ?? '').replace(/\s/g, '');
        if (value.length > 90000) throw new Error('DASH PSSH exceeds limit');
        const bytes = Uint8Array.from(atob(value), (v) => v.charCodeAt(0));
        if (bytes.length > 65536) throw new Error('DASH PSSH exceeds limit');
        return bytes;
      }),
  }));
}
/** Browser XML parser supplies namespace/entity handling; no remote XML resolution. */
export function parseMpd(xml: string, url: string): Manifest {
  if (xml.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Unsafe or oversized DASH MPD');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length)
    throw new Error('Malformed DASH XML');
  const root = doc.documentElement;
  if (root.localName !== 'MPD' || root.namespaceURI !== ns)
    throw new Error('Expected MPEG-DASH MPD');
  if (doc.querySelectorAll('*').length > 150000)
    throw new Error('DASH MPD element limit');
  if (
    Array.from(doc.querySelectorAll('*')).some((e) =>
      e.hasAttributeNS('http://www.w3.org/1999/xlink', 'href'),
    )
  )
    throw new Error('DASH XLink resolution is not implemented');
  if (root.getElementsByTagNameNS(ns, 'EssentialProperty').length)
    throw new Error('DASH EssentialProperty profiles are not implemented yet');
  const type = attr(root, 'type') ?? 'static';
  if (!['static', 'dynamic'].includes(type))
    throw new Error('Invalid DASH MPD type');
  const manifest: Manifest = {
    url,
    id: attr(root, 'id') ?? '',
    live: type === 'dynamic',
    duration: duration(attr(root, 'mediaPresentationDuration')),
    minBufferTime: duration(attr(root, 'minBufferTime')) ?? 1.5,
    minimumUpdatePeriod: duration(attr(root, 'minimumUpdatePeriod')),
    availabilityStartTime: date(attr(root, 'availabilityStartTime')),
    publishTime: date(attr(root, 'publishTime')),
    timeShiftBufferDepth: duration(attr(root, 'timeShiftBufferDepth')),
    suggestedPresentationDelay: duration(
      attr(root, 'suggestedPresentationDelay'),
    ),
    utcTiming: children(root, 'UTCTiming').map((e) => ({
      scheme: attr(e, 'schemeIdUri') ?? '',
      value: attr(e, 'value') ?? '',
    })),
    locations: children(root, 'Location').map((e) =>
      resolveUrl(e.textContent!.trim(), url),
    ),
    periods: [],
  };
  if (manifest.live && manifest.availabilityStartTime === undefined)
    throw new Error('Dynamic DASH MPD needs availabilityStartTime');
  const rootBases = bases(root, [url]),
    rootAddress = address(root);
  for (const [pi, pe] of children(root, 'Period').entries()) {
    const previous = manifest.periods.at(-1);
    const start =
      duration(attr(pe, 'start')) ??
      (previous
        ? previous.duration === undefined
          ? undefined
          : previous.start + previous.duration
        : 0);
    if (start === undefined) throw new Error('Ambiguous DASH Period start');
    const period: Period = {
      id: attr(pe, 'id') ?? `period-${pi}`,
      start,
      duration: duration(attr(pe, 'duration')),
      adaptations: [],
    };
    const pb = bases(pe, rootBases),
      pa = address(pe, rootAddress);
    for (const [ai, ae] of children(pe, 'AdaptationSet').entries()) {
      const ab = bases(ae, pb),
        aa = address(ae, pa);
      const roles = children(ae, 'Role').map((e) => attr(e, 'value') ?? '');
      const reps: Representation[] = [];
      for (const [ri, re] of children(ae, 'Representation').entries()) {
        const get = (name: string) => attr(re, name) ?? attr(ae, name);
        const segmentAddress = address(re, aa);
        if (!segmentAddress)
          throw new Error('DASH representation needs segment addressing');
        const mimeType = get('mimeType') ?? '';
        const bandwidth = decimal(attr(re, 'bandwidth'), 0, 1);
        if (!bandwidth) throw new Error('DASH representation needs bandwidth');
        const frame = get('frameRate')?.split('/');
        const frameRate = frame
          ? Number(frame[0]) / Number(frame[1] ?? 1)
          : undefined;
        if (
          frame &&
          (frame.length > 2 || !Number.isFinite(frameRate) || frameRate! <= 0)
        )
          throw new Error('Invalid DASH frame rate');
        reps.push({
          id: attr(re, 'id') ?? `representation-${ri}`,
          bandwidth,
          mimeType,
          codecs: get('codecs') ?? '',
          width: get('width') ? decimal(get('width'), 0, 1) : undefined,
          height: get('height') ? decimal(get('height'), 0, 1) : undefined,
          frameRate,
          baseUrls: bases(re, ab),
          address: segmentAddress,
          protection: [...protections(ae), ...protections(re)],
        });
      }
      const mime = reps[0]?.mimeType ?? attr(ae, 'mimeType') ?? '';
      const content =
        attr(ae, 'contentType') ??
        one(ae, 'ContentComponent')?.getAttribute('contentType');
      const kind =
        content === 'video' || mime.startsWith('video/')
          ? 'video'
          : content === 'audio' || mime.startsWith('audio/')
            ? 'audio'
            : 'text';
      if (reps.length)
        period.adaptations.push({
          id: attr(ae, 'id') ?? `adaptation-${ai}`,
          kind,
          language: attr(ae, 'lang') ?? '',
          label:
            one(ae, 'Label')?.textContent?.trim() ?? attr(ae, 'lang') ?? kind,
          roles,
          representations: reps,
        });
    }
    manifest.periods.push(period);
  }
  if (!manifest.periods.length || manifest.periods.length > 1000)
    throw new Error('Invalid DASH Period count');
  for (let i = 0; i < manifest.periods.length; i++) {
    const p = manifest.periods[i],
      next = manifest.periods[i + 1];
    p.duration ??= next
      ? next.start - p.start
      : manifest.duration === undefined
        ? undefined
        : manifest.duration - p.start;
    if (p.duration !== undefined && p.duration <= 0)
      throw new Error('Invalid DASH Period duration');
    if (
      next &&
      p.duration !== undefined &&
      p.start + p.duration > next.start + 0.001
    )
      throw new Error('Overlapping DASH Periods');
  }
  if (!manifest.live && manifest.duration === undefined) {
    const tail = manifest.periods.at(-1)!;
    if (tail.duration !== undefined)
      manifest.duration = tail.start + tail.duration;
  }
  return manifest;
}
