import type { TimedDateRange } from './date-ranges';
import type { Playlist } from './playlist';
import { ResourceClient } from './network';
export interface SkipControl {
  offset?: number;
  duration?: number;
  label?: string;
}
export interface Interstitial {
  range: TimedDateRange;
  uri?: string;
  list?: string;
  resumeOffset?: number;
  limit?: number;
  snap: string[];
  restrict: string[];
  skip: SkipControl;
  occupies: 'POINT' | 'RANGE';
  style: 'HIGHLIGHT' | 'PRIMARY';
}
export interface InterstitialAsset {
  uri: string;
  duration?: number;
}
const seconds = (
  value: unknown,
  name: string,
  signed = false,
  integer = false,
) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new Error('Invalid interstitial ' + name);
  const n = typeof value === 'number' ? value : Number(value);
  if (
    value === '' ||
    !Number.isFinite(n) ||
    (!signed && n < 0) ||
    (integer && !Number.isSafeInteger(n))
  )
    throw new Error('Invalid interstitial ' + name);
  return n;
};
function http(value: string, base?: string) {
  const u = new URL(value, base);
  if (!['http:', 'https:'].includes(u.protocol))
    throw new Error('Interstitials require HTTP(S)');
  return u.href;
}
export function skipControl(
  input: Record<string, unknown>,
  prefix = '',
): SkipControl {
  const offset = seconds(input[prefix + 'OFFSET'], 'skip offset', false, true),
    duration = seconds(
      input[prefix + 'DURATION'],
      'skip duration',
      false,
      true,
    ),
    label = input[prefix + 'LABEL-ID'];
  if (
    label !== undefined &&
    (typeof label !== 'string' || !/^[A-Za-z_-]+$/.test(label))
  )
    throw new Error('Invalid interstitial skip label');
  return { offset, duration, label: label as string | undefined };
}
export function parseInterstitial(
  range: TimedDateRange,
  base: string,
): Interstitial {
  const a = range.attributes,
    uri = a['X-ASSET-URI'],
    list = a['X-ASSET-LIST'];
  if (range.class !== 'com.apple.hls.interstitial' || !!uri === !!list)
    throw new Error('Interstitial requires exactly one asset URI or list');
  return {
    range,
    uri: uri ? http(uri) : undefined,
    list: list ? http(list, base) : undefined,
    resumeOffset: seconds(a['X-RESUME-OFFSET'], 'resume offset', true),
    limit: seconds(a['X-PLAYOUT-LIMIT'], 'playout limit'),
    snap: a['X-SNAP']?.split(',') ?? [],
    restrict: a['X-RESTRICT']?.split(',') ?? [],
    skip: skipControl(a, 'X-SKIP-CONTROL-'),
    occupies: a['X-TIMELINE-OCCUPIES'] === 'RANGE' ? 'RANGE' : 'POINT',
    style: a['X-TIMELINE-STYLE'] === 'PRIMARY' ? 'PRIMARY' : 'HIGHLIGHT',
  };
}
export function parseAssetList(input: unknown): {
  assets: InterstitialAsset[];
  skip?: SkipControl;
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid interstitial asset list');
  const data = input as Record<string, unknown>;
  if (!Array.isArray(data.ASSETS) || data.ASSETS.length > 128)
    throw new Error('Invalid interstitial assets');
  const assets = data.ASSETS.map((raw) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      typeof raw.URI !== 'string' ||
      typeof raw.DURATION !== 'number'
    )
      throw new Error('Invalid interstitial asset');
    return {
      uri: http(raw.URI),
      duration: seconds(raw.DURATION, 'asset duration')!,
    };
  });
  const skip = data['SKIP-CONTROL'];
  if (
    skip !== undefined &&
    (!skip || typeof skip !== 'object' || Array.isArray(skip))
  )
    throw new Error('Invalid interstitial skip control');
  return {
    assets,
    skip:
      skip === undefined
        ? undefined
        : skipControl(skip as Record<string, unknown>),
  };
}
export function interstitialUrl(
  uri: string,
  id: string,
  session: string,
  startOffset?: number,
) {
  const u = new URL(uri);
  // Preserve signed query bytes, adding only missing protocol context.
  const add = (name: string, value: string) => {
    if (!u.searchParams.has(name))
      u.search +=
        (u.search ? '&' : '?') + name + '=' + encodeURIComponent(value);
  };
  add('_HLS_interstitial_id', id);
  add('_HLS_primary_id', session);
  if (startOffset !== undefined)
    add('_HLS_start_offset', String(Math.max(0, startOffset)));
  return u.href;
}
export async function resolveInterstitial(
  event: Interstitial,
  client: ResourceClient,
  session: string,
  startOffset?: number,
) {
  if (event.uri)
    return {
      assets: [
        {
          uri: interstitialUrl(event.uri, event.range.id, session, startOffset),
        },
      ] as InterstitialAsset[],
      skip: event.skip,
    };
  const response = await client.get(
    { url: interstitialUrl(event.list!, event.range.id, session, startOffset) },
    { timeoutMs: 60000, recoveryWindowMs: 0, retries: 0 },
  );
  if (response.data.length > 1024 * 1024)
    throw new Error('Interstitial asset list exceeds 1 MiB');
  const result = parseAssetList(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.data)),
  );
  const overrides = Object.fromEntries(
    Object.entries(result.skip ?? {}).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return {
    assets: result.assets.map((a) => ({
      ...a,
      uri: interstitialUrl(a.uri, event.range.id, session, startOffset),
    })),
    skip: { ...event.skip, ...overrides },
  };
}
export function skipAvailable(control: SkipControl, elapsed: number) {
  return (
    control.offset !== undefined &&
    elapsed >= control.offset &&
    (control.duration === undefined ||
      elapsed < control.offset + control.duration)
  );
}
export function snapInterstitial(
  time: number,
  playlists: Playlist[],
  direction: 'OUT' | 'IN',
) {
  const closest = playlists.map((p) => {
    const bounds = p.segments.flatMap((s) => [s.start, s.start + s.duration]);
    return bounds.reduce(
      (best, n) => (Math.abs(n - time) < Math.abs(best - time) ? n : best),
      bounds[0] ?? time,
    );
  });
  if (!closest.length) return time;
  return direction === 'OUT' ? Math.min(...closest) : Math.max(...closest);
}
export function interstitialResume(
  event: Interstitial,
  scheduled: number,
  played: number,
  cancelled = false,
) {
  return Math.max(
    0,
    scheduled +
      (cancelled
        ? 0
        : (event.resumeOffset ?? Math.min(played, event.limit ?? Infinity))),
  );
}
