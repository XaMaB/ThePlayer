/** HLS playlist model. Implemented from RFC 8216; no third-party parser. */
export type Attributes = Record<string, string>;
export interface ByteRange {
  offset: number;
  length: number;
}
export interface Resource {
  url: string;
  range?: ByteRange;
}
export interface Key {
  method: string;
  url?: string;
  iv?: Uint8Array;
  format: string;
}
export interface Segment extends Resource {
  sequence: number;
  start: number;
  duration: number;
  discontinuity: number;
  map?: Resource;
  key?: Key;
  gap: boolean;
  programDateTime?: string;
}
export interface Variant {
  url: string;
  bandwidth: number;
  codecs?: string;
  resolution?: string;
  audio?: string;
  subtitles?: string;
}
export interface Rendition {
  type: string;
  group: string;
  name: string;
  language: string;
  url?: string;
  default: boolean;
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
  parts: Attributes[];
  unsupported: string[];
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
  const uri = (value: string) => {
    const replaced = value.replace(/\{\$([a-zA-Z0-9_-]+)\}/g, (_, name) => {
      if (!(name in variables))
        throw new Error(`Undefined HLS variable: ${name}`);
      return variables[name];
    });
    const url = new URL(replaced, base);
    if (!['https:', 'http:'].includes(url.protocol))
      throw new Error('HLS resources require HTTP(S)');
    return url.href;
  };
  let duration: number | undefined,
    variant: Attributes | undefined,
    byteRange: string | undefined;
  let map: Resource | undefined,
    key: Key | undefined,
    discontinuity = 0,
    gap = false,
    date: string | undefined;
  let previousRange: { url: string; end: number } | undefined;
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
        gap,
        programDateTime: date,
      });
      p.duration += duration;
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
          range: a.BYTERANGE ? range(a.BYTERANGE, undefined, url) : undefined,
        };
        break;
      }
      case '#EXT-X-KEY': {
        const a = attributes(value);
        if (a.METHOD === 'NONE') {
          key = undefined;
          break;
        }
        let iv: Uint8Array | undefined;
        if (a.IV) {
          if (!/^0x[0-9a-f]{1,32}$/i.test(a.IV))
            throw new Error('Invalid AES IV');
          iv = Uint8Array.from(
            a.IV.slice(2).padStart(32, '0').match(/../g)!,
            (pair) => parseInt(pair, 16),
          );
        }
        key = {
          method: a.METHOD,
          url: a.URI ? uri(a.URI) : undefined,
          iv,
          format: a.KEYFORMAT ?? 'identity',
        };
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
        p.renditions.push({
          type: a.TYPE,
          group: a['GROUP-ID'],
          name: a.NAME,
          language: a.LANGUAGE ?? 'und',
          url: a.URI ? uri(a.URI) : undefined,
          default: a.DEFAULT === 'YES',
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
      case '#EXT-X-PART':
        p.parts.push(attributes(value));
        break;
      case '#EXT-X-SKIP':
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
  if (!p.variants.length && (!p.targetDuration || !p.segments.length))
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
      old.url !== overlap.url ||
      JSON.stringify(old.range) !== JSON.stringify(overlap.range) ||
      Math.abs(old.duration - overlap.duration) > 0.05
    )
      throw new Error('Live playlist changed an existing segment');
    shift = old.start - overlap.start;
  } else {
    const tail = previous.segments.at(-1)!;
    if (next.segments[0].sequence !== tail.sequence + 1)
      throw new Error('Live window lost synchronization; reconnect required');
    shift = tail.start + tail.duration;
  }
  next.segments = next.segments.map((s) => ({ ...s, start: s.start + shift }));
  return next;
}
