/** HLS playlist model. Implemented from RFC 8216; no third-party parser. */
export type Attributes = Record<string, string>;
export interface ByteRange {
  offset: number;
  length: number;
}
export interface Resource {
  url: string;
  range?: ByteRange;
  /** Preload-only range with an unknown final byte. */
  rangeStart?: number;
}
export interface Initialization extends Resource {
  key?: Key;
  keys?: Key[];
}
export interface Key {
  method: string;
  versions?: number[];
  scope?: string;
  url?: string;
  iv?: Uint8Array;
  format: string;
}
export interface Segment extends Resource {
  sequence: number;
  start: number;
  duration: number;
  discontinuity: number;
  map?: Initialization;
  keys?: Key[];
  key?: Key;
  gap: boolean;
  programDateTime?: string;
  part?: number;
  partOffset?: number;
  independent?: boolean;
}
export interface Variant {
  url: string;
  bandwidth: number;
  codecs?: string;
  resolution?: string;
  audio?: string;
  subtitles?: string;
  closedCaptions?: string;
}
export interface Rendition {
  type: string;
  group: string;
  name: string;
  language: string;
  url?: string;
  default: boolean;
  autoselect: boolean;
  forced: boolean;
  associatedLanguage?: string;
  instreamId?: string;
  characteristics: string[];
}
export interface Playlist {
  url: string;
  version: number;
  variables: Attributes;
  live: boolean;
  targetDuration: number;
  sequence: number;
  type?: string;
  duration: number;
  segments: Segment[];
  variants: Variant[];
  renditions: Rendition[];
  independent: boolean;
  startOffset?: number;
  serverControl?: Attributes;
  parts: Segment[];
  parents?: Segment[];
  partTarget?: number;
  preload?: Resource;
  preloadMap?: Resource;
  nextMap?: Initialization;
  reports?: { url: string; sequence?: number; part?: number }[];
  skipped?: number;
  unsupported: string[];
  sessionKeys?: Key[];
}
export function attributes(input: string): Attributes {
  const result: Attributes = {};
  let at = 0;
  while (at < input.length) {
    const match = /^([A-Z0-9-]+)=/.exec(input.slice(at));
    if (!match) throw new Error('Invalid HLS attribute list');
    const name = match[1];
    at += match[0].length;
    if (name in result) throw new Error(`Duplicate HLS attribute: ${name}`);
    if (input[at] === '"') {
      const end = input.indexOf('"', ++at);
      if (end < 0) throw new Error('Unterminated HLS quoted string');
      result[name] = input.slice(at, end);
      at = end + 1;
    } else {
      const end = input.indexOf(',', at);
      result[name] = input.slice(at, end < 0 ? input.length : end);
      at = end < 0 ? input.length : end;
    }
    if (at < input.length && input[at++] !== ',')
      throw new Error('Invalid HLS attribute separator');
  }
  return result;
}
function number(
  value: string | undefined,
  name: string,
  integer = false,
): number {
  const n = Number(value);
  if (
    value == null ||
    value === '' ||
    !Number.isFinite(n) ||
    n < 0 ||
    (integer && !Number.isSafeInteger(n))
  )
    throw new Error(`Invalid ${name}`);
  return n;
}
function range(
  value: string,
  previous?: { url: string; end: number },
  url = '',
): ByteRange {
  const [length, offset] = value.split('@');
  const result = {
    length: number(length, 'byte range length', true),
    offset:
      offset == null
        ? previous?.url === url
          ? previous.end
          : NaN
        : number(offset, 'byte range offset', true),
  };
  if (
    !result.length ||
    !Number.isSafeInteger(result.offset) ||
    !Number.isSafeInteger(result.offset + result.length)
  )
    throw new Error(
      'Byte range needs a valid offset or a preceding range of the same resource',
    );
  return result;
}
export function parsePlaylist(
  text: string,
  base: string,
  inherited: Attributes = {},
  previous?: Playlist,
): Playlist {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist');
  const p: Playlist = {
    url: base,
    version: 1,
    variables: {},
    live: true,
    targetDuration: 0,
    sequence: 0,
    duration: 0,
    segments: [],
    variants: [],
    renditions: [],
    independent: false,
    parts: [],
    unsupported: [],
  };
  const variables = p.variables;
  const uri = (value: string, opaque = false) => {
    const replaced = value.replace(/\{\$([a-zA-Z0-9_-]+)\}/g, (_, name) => {
      if (!(name in variables))
        throw new Error(`Undefined HLS variable: ${name}`);
      return variables[name];
    });
    const url = new URL(replaced, base);
    if (!opaque && !['https:', 'http:'].includes(url.protocol))
      throw new Error('HLS resources require HTTP(S)');
    return url.href;
  };
  let duration: number | undefined,
    variant: Attributes | undefined,
    byteRange: string | undefined;
  let map: Initialization | undefined,
    key: Key | undefined,
    discontinuity = 0,
    gap = false,
    date: string | undefined;
  const activeKeys = new Map<string, Key>();
  let keyDeclaration = 0;
  const chooseKey = () =>
    [...activeKeys.values()].find(
      (k) => k.format === 'identity' && (k.versions ?? [1]).includes(1),
    ) ?? activeKeys.values().next().value;
  let previousRange: { url: string; end: number } | undefined;
  let previousPartRange: { url: string; end: number } | undefined;
  let partIndex = 0,
    partOffset = 0;
  for (const line of lines.slice(1)) {
    if (!line.startsWith('#')) {
      const url = uri(line);
      if (variant) {
        p.variants.push({
          url,
          bandwidth: number(variant.BANDWIDTH, 'BANDWIDTH', true),
          codecs: variant.CODECS,
          resolution: variant.RESOLUTION,
          audio: variant.AUDIO,
          subtitles: variant.SUBTITLES,
          closedCaptions: variant['CLOSED-CAPTIONS'],
        });
        variant = undefined;
        continue;
      }
      if (duration === undefined) throw new Error('Media URI without EXTINF');
      const r = byteRange ? range(byteRange, previousRange, url) : undefined;
      previousRange = r ? { url, end: r.offset + r.length } : undefined;
      p.segments.push({
        url,
        range: r,
        sequence: p.sequence + p.segments.length,
        start: p.duration,
        duration,
        discontinuity,
        map,
        key,
        keys: [...activeKeys.values()],
        gap,
        programDateTime: date,
      });
      p.duration += duration;
      partIndex = 0;
      partOffset = 0;
      duration = undefined;
      byteRange = undefined;
      gap = false;
      date = undefined;
      continue;
    }
    const colon = line.indexOf(':');
    const tag = colon < 0 ? line : line.slice(0, colon),
      value = colon < 0 ? '' : line.slice(colon + 1);
    if (/(?:^|,)REQ-[A-Z0-9-]+=/.test(value))
      p.unsupported.push(tag + ' required extension');
    switch (tag) {
      case '#EXT-X-VERSION':
        p.version = number(value, 'VERSION', true);
        if (p.version < 1 || p.version > 13)
          throw new Error(`Unsupported HLS version ${p.version}`);
        break;
      case '#EXT-X-TARGETDURATION':
        p.targetDuration = number(value, 'TARGETDURATION', true);
        break;
      case '#EXT-X-MEDIA-SEQUENCE':
        p.sequence = number(value, 'MEDIA-SEQUENCE', true);
        break;
      case '#EXT-X-DISCONTINUITY-SEQUENCE':
        discontinuity = number(value, 'DISCONTINUITY-SEQUENCE', true);
        break;
      case '#EXT-X-DISCONTINUITY':
        discontinuity++;
        break;
      case '#EXT-X-ENDLIST':
        p.live = false;
        break;
      case '#EXT-X-PLAYLIST-TYPE':
        p.type = value;
        break;
      case '#EXT-X-INDEPENDENT-SEGMENTS':
        p.independent = true;
        break;
      case '#EXTINF':
        duration = number(value.split(',')[0], 'EXTINF');
        if (!duration) throw new Error('Zero-duration segment');
        break;
      case '#EXT-X-BYTERANGE':
        byteRange = value;
        break;
      case '#EXT-X-MAP': {
        const a = attributes(value);
        if (!a.URI) throw new Error('Missing map URI');
        const url = uri(a.URI);
        map = {
          url,
          key,
          keys: [...activeKeys.values()],
          range: a.BYTERANGE ? range(a.BYTERANGE, undefined, url) : undefined,
        };
        break;
      }
      case '#EXT-X-SESSION-KEY':
      case '#EXT-X-KEY': {
        const a = attributes(value);
        if (!a.METHOD) throw new Error('Missing HLS encryption method');
        if (a.METHOD === 'NONE') {
          if (tag === '#EXT-X-SESSION-KEY' || Object.keys(a).length !== 1)
            throw new Error('Invalid METHOD=NONE attributes');
          activeKeys.clear();
          key = undefined;
          break;
        }
        if (!a.URI) throw new Error('Missing HLS key URI');
        if (a.IV && ['AES-256-GCM', 'SAMPLE-AES-CTR'].includes(a.METHOD))
          throw new Error('IV is forbidden for ' + a.METHOD);
        const versions = (a.KEYFORMATVERSIONS ?? '1')
          .split('/')
          .map((v) => number(v, 'KEYFORMATVERSIONS', true));
        if (versions.some((v) => !v))
          throw new Error('Invalid KEYFORMATVERSIONS');
        let iv: Uint8Array | undefined;
        if (a.IV) {
          if (!/^0x[0-9a-f]{1,32}$/i.test(a.IV))
            throw new Error('Invalid AES IV');
          iv = Uint8Array.from(
            a.IV.slice(2).padStart(32, '0').match(/../g)!,
            (pair) => parseInt(pair, 16),
          );
        }
        const declaration: Key = {
          method: a.METHOD,
          versions,
          scope: `${base}|${p.sequence + p.segments.length}:${partIndex}:${keyDeclaration++}`,
          url: a.URI
            ? uri(a.URI, !!a.KEYFORMAT && a.KEYFORMAT !== 'identity')
            : undefined,
          iv,
          format: a.KEYFORMAT ?? 'identity',
        };
        if (tag === '#EXT-X-SESSION-KEY')
          (p.sessionKeys ??= []).push(declaration);
        else {
          activeKeys.set(declaration.format, declaration);
          key = chooseKey();
        }
        break;
      }
      case '#EXT-X-GAP':
        gap = true;
        break;
      case '#EXT-X-PROGRAM-DATE-TIME':
        date = value;
        break;
      case '#EXT-X-STREAM-INF':
        variant = attributes(value);
        break;
      case '#EXT-X-MEDIA': {
        const a = attributes(value);
        if (
          !a.TYPE ||
          !['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(
            a.TYPE,
          ) ||
          !a['GROUP-ID'] ||
          !a.NAME
        )
          throw new Error('Invalid EXT-X-MEDIA identity');
        for (const flag of ['DEFAULT', 'AUTOSELECT', 'FORCED'])
          if (a[flag] !== undefined && !['YES', 'NO'].includes(a[flag]))
            throw new Error(`Invalid ${flag}`);
        if (a.DEFAULT === 'YES' && a.AUTOSELECT === 'NO')
          throw new Error('DEFAULT=YES requires AUTOSELECT=YES when present');
        if (a.FORCED !== undefined && a.TYPE !== 'SUBTITLES')
          throw new Error('FORCED is only valid for SUBTITLES');
        if (a.TYPE === 'SUBTITLES' && !a.URI)
          throw new Error('SUBTITLES requires URI');
        const group = p.renditions.filter(
          (r) => r.type === a.TYPE && r.group === a['GROUP-ID'],
        );
        if (group.some((r) => r.name === a.NAME))
          throw new Error('Duplicate rendition NAME');
        if (a.DEFAULT === 'YES' && group.some((r) => r.default))
          throw new Error('Multiple DEFAULT renditions in group');
        p.renditions.push({
          type: a.TYPE,
          group: a['GROUP-ID'],
          name: a.NAME,
          language: a.LANGUAGE ?? 'und',
          url: a.URI
            ? uri(a.URI, !!a.KEYFORMAT && a.KEYFORMAT !== 'identity')
            : undefined,
          default: a.DEFAULT === 'YES',
          autoselect: a.AUTOSELECT === 'YES',
          forced: a.FORCED === 'YES',
          associatedLanguage: a['ASSOC-LANGUAGE'],
          instreamId: a['INSTREAM-ID'],
          characteristics: a.CHARACTERISTICS?.split(',') ?? [],
        });
        break;
      }
      case '#EXT-X-START': {
        const a = attributes(value);
        const n = Number(a['TIME-OFFSET']);
        if (!Number.isFinite(n)) throw new Error('Invalid TIME-OFFSET');
        p.startOffset = n;
        break;
      }
      case '#EXT-X-DEFINE': {
        const a = attributes(value);
        if (a.IMPORT) {
          if (!(a.IMPORT in inherited))
            throw new Error('Missing imported variable');
          variables[a.IMPORT] = inherited[a.IMPORT];
        } else if (a.QUERYPARAM) {
          const v = new URL(base).searchParams.get(a.QUERYPARAM);
          if (v == null) throw new Error('Missing query variable');
          variables[a.QUERYPARAM] = v;
        } else if (a.NAME && a.VALUE != null) variables[a.NAME] = a.VALUE;
        break;
      }
      case '#EXT-X-SERVER-CONTROL':
        p.serverControl = attributes(value);
        break;
      case '#EXT-X-PART-INF':
        p.partTarget = number(attributes(value)['PART-TARGET'], 'PART-TARGET');
        if (!p.partTarget) throw new Error('Zero part target duration');
        break;
      case '#EXT-X-PART': {
        const a = attributes(value);
        if (!a.URI) throw new Error('Missing partial segment URI');
        const url = uri(a.URI),
          duration = number(a.DURATION, 'part DURATION');
        if (!duration) throw new Error('Zero part duration');
        for (const flag of ['INDEPENDENT', 'GAP'])
          if (a[flag] !== undefined && !['YES', 'NO'].includes(a[flag]))
            throw new Error('Invalid part ' + flag);
        const r = a.BYTERANGE
          ? range(a.BYTERANGE, previousPartRange, url)
          : undefined;
        previousPartRange = r ? { url, end: r.offset + r.length } : undefined;
        p.parts.push({
          url,
          range: r,
          sequence: p.sequence + p.segments.length,
          start: p.duration + partOffset,
          duration,
          discontinuity,
          map,
          key,
          keys: [...activeKeys.values()],
          gap: a.GAP === 'YES',
          part: partIndex++,
          partOffset,
          independent:
            a.INDEPENDENT === 'YES' || (p.independent && partIndex === 1),
          programDateTime: date
            ? new Date(Date.parse(date) + partOffset * 1000).toISOString()
            : undefined,
        });
        partOffset += duration;
        break;
      }
      case '#EXT-X-PRELOAD-HINT': {
        const a = attributes(value);
        if (!['PART', 'MAP'].includes(a.TYPE)) break;
        if (!a.URI) throw new Error('Missing preload hint URI');
        const field = a.TYPE === 'MAP' ? 'preloadMap' : 'preload';
        if (p[field]) throw new Error('Duplicate preload hint type');
        const offset = number(a['BYTERANGE-START'] ?? '0', 'hint offset', true);
        if (offset < 0) throw new Error('Invalid hint offset');
        const length =
          a['BYTERANGE-LENGTH'] == null
            ? undefined
            : number(a['BYTERANGE-LENGTH'], 'hint length', true);
        if (
          length != null &&
          (length <= 0 || !Number.isSafeInteger(offset + length))
        )
          throw new Error('Invalid hint length');
        p[field] = {
          url: uri(a.URI),
          ...(length != null
            ? { range: { offset, length } }
            : a['BYTERANGE-START'] != null
              ? { rangeStart: offset }
              : {}),
        };
        break;
      }
      case '#EXT-X-RENDITION-REPORT': {
        const a = attributes(value);
        if (!a.URI) throw new Error('Missing rendition report URI');
        (p.reports ??= []).push({
          url: uri(a.URI),
          sequence:
            a['LAST-MSN'] === undefined
              ? undefined
              : number(a['LAST-MSN'], 'LAST-MSN', true),
          part:
            a['LAST-PART'] === undefined
              ? undefined
              : number(a['LAST-PART'], 'LAST-PART', true),
        });
        break;
      }
      case '#EXT-X-SKIP': {
        const a = attributes(value);
        const count = number(a['SKIPPED-SEGMENTS'], 'SKIPPED-SEGMENTS', true);
        if (
          p.skipped !== undefined ||
          p.segments.length ||
          duration !== undefined
        )
          throw new Error('Invalid delta skip placement');
        p.skipped = count;
        const cached =
          (previous?.parents ?? previous?.segments)?.filter(
            (s) => s.sequence >= p.sequence && s.sequence < p.sequence + count,
          ) ?? [];
        if (
          cached.length !== count ||
          cached.some((s, i) => s.sequence !== p.sequence + i) ||
          (count && cached[0].discontinuity !== discontinuity)
        )
          throw new MissingDeltaBase();
        for (const old of cached) {
          p.segments.push({ ...old, start: p.duration });
          p.duration += old.duration;
          for (const part of previous?.parts.filter(
            (part) => part.sequence === old.sequence,
          ) ?? [])
            p.parts.push({
              ...part,
              start: p.duration - old.duration + (part.partOffset ?? 0),
            });
        }
        const tail = cached.at(-1);
        if (tail) {
          map = tail.map;
          key = tail.key;
          activeKeys.clear();
          for (const oldKey of tail.keys ?? (key ? [key] : []))
            activeKeys.set(oldKey.format, oldKey);
          discontinuity = tail.discontinuity;
          previousRange = tail.range
            ? { url: tail.url, end: tail.range.offset + tail.range.length }
            : undefined;
        }
        break;
      }
      case '#EXT-X-I-FRAMES-ONLY':
        p.unsupported.push(tag);
        break;
      default:
        break;
    }
  }
  if (variant || duration !== undefined)
    throw new Error('Incomplete playlist entry');
  if (p.variants.length && p.segments.length)
    throw new Error('Mixed multivariant and media playlist');
  if (p.parts.length && !p.partTarget)
    throw new Error('Partial segments require PART-INF');
  p.nextMap = map;
  p.duration += partOffset;
  const reportedTail = p.parts.at(-1) ?? p.segments.at(-1);
  for (const report of p.reports ?? []) {
    report.sequence ??= reportedTail?.sequence;
    report.part ??= p.parts.at(-1)?.part;
  }
  if (
    !p.variants.length &&
    (!p.targetDuration || (!p.segments.length && !p.parts.length))
  )
    throw new Error('No complete media segments or missing target duration');
  return p;
}
/** Preserve media-time positions while a live window slides. Reject unsynchronized resets. */
export function alignPlaylist(next: Playlist, previous: Playlist): Playlist {
  const overlap = next.segments.find((s) =>
    previous.segments.some(
      (old) =>
        old.sequence === s.sequence && old.discontinuity === s.discontinuity,
    ),
  );
  let shift: number;
  if (overlap) {
    const old = previous.segments.find(
      (s) =>
        s.sequence === overlap.sequence &&
        s.discontinuity === overlap.discontinuity,
    )!;
    if (
      old.part === overlap.part &&
      (old.url !== overlap.url ||
        JSON.stringify(old.range) !== JSON.stringify(overlap.range) ||
        JSON.stringify(old.map) !== JSON.stringify(overlap.map) ||
        (old.programDateTime &&
          overlap.programDateTime &&
          old.programDateTime !== overlap.programDateTime) ||
        Math.abs(old.duration - overlap.duration) > 0.05)
    )
      throw new Error('Live playlist changed an existing segment');
    shift =
      old.start -
      (old.partOffset ?? 0) -
      overlap.start +
      (overlap.partOffset ?? 0);
  } else {
    const tail = previous.segments.at(-1)!;
    if (next.segments[0].sequence !== tail.sequence + 1)
      throw new Error('Live window lost synchronization; reconnect required');
    shift = tail.start + tail.duration;
  }
  return shiftPlaylist(next, shift);
}

export class MissingDeltaBase extends Error {
  constructor() {
    super('HLS delta update requires a complete playlist reload');
    this.name = 'MissingDeltaBase';
  }
}

export function shiftPlaylist(p: Playlist, shift: number): Playlist {
  const shifted = (s: Segment) => ({ ...s, start: s.start + shift });
  return {
    ...p,
    segments: p.segments.map(shifted),
    parents: p.parents?.map(shifted),
    parts: p.parts.map(shifted),
  };
}
/** A parent is represented once: by its parts when complete, or by the whole segment. */
export function playablePlaylist(p: Playlist): Playlist {
  if (!p.parts.length) return p;
  const segments: Segment[] = [];
  for (const parent of p.segments) {
    const parts = p.parts.filter((part) => part.sequence === parent.sequence);
    const sum = parts.reduce((n, part) => n + part.duration, 0);
    if (parts.length && Math.abs(sum - parent.duration) < 0.05)
      segments.push(...parts);
    else segments.push(parent);
  }
  segments.push(
    ...p.parts.filter(
      (part) => part.sequence >= p.sequence + p.segments.length,
    ),
  );
  return { ...p, parents: p.segments, segments };
}
export function independentIndex(p: Playlist, index: number): number {
  index = Math.min(index, p.segments.length - 1);
  while (
    index > 0 &&
    p.segments[index].part !== undefined &&
    !p.segments[index].independent
  )
    index--;
  if (p.segments[index]?.part !== undefined && !p.segments[index].independent)
    throw new Error('No independent partial segment available for startup');
  return index;
}

export function holdBack(p: Playlist): number {
  return p.partTarget
    ? Math.max(
        2 * p.partTarget,
        Number(p.serverControl?.['PART-HOLD-BACK']) || 3 * p.partTarget,
      )
    : Math.max(
        3 * p.targetDuration,
        Number(p.serverControl?.['HOLD-BACK']) || 0,
      );
}
