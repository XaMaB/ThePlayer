export interface CmcdOptions {
  version?: 1 | 2;
  mode?: 'query' | 'headers';
  sessionId?: string;
  contentId?: string;
}
export interface MediaRequest {
  type: 'm' | 'i' | 'v' | 'a' | 'tt' | 'o';
  duration?: number;
  bitrate?: number;
}
export interface ClientMetrics {
  live?: boolean;
  buffer: number;
  throughput: number;
  startup: boolean;
}
/** Request-mode fields only. Telemetry is opt-in and contains no source URLs. */
export function cmcd(
  options: CmcdOptions,
  request: MediaRequest,
  metrics: ClientMetrics,
) {
  const version = options.version ?? 2;
  if (
    ![1, 2].includes(version) ||
    (options.mode && !['query', 'headers'].includes(options.mode))
  )
    throw new Error('Invalid CMCD configuration');
  const session: Record<string, string> = { sf: 'd' };
  if (version === 2) session.v = '2';
  if (metrics.live !== undefined) session.st = metrics.live ? 'l' : 'v';
  for (const [key, value] of [
    ['sid', options.sessionId],
    ['cid', options.contentId],
  ]) {
    if (value === undefined) continue;
    if (value.length > 64 || !/^[\x20-\x7e]*$/.test(value))
      throw new Error(
        'CMCD identifiers must contain at most 64 printable ASCII characters',
      );
    session[key!] = JSON.stringify(value);
  }
  const object: Record<string, string> = { ot: request.type },
    current: Record<string, string> = {};
  const rounded = (n: number, unit = 1) =>
    String(Math.max(0, Math.round(n / unit) * unit));
  if (request.duration !== undefined)
    object.d = rounded(request.duration * 1000);
  if (request.bitrate && ['a', 'v'].includes(request.type)) {
    const br = rounded(request.bitrate / 1000);
    object.br = version === 2 ? `(${br};${request.type})` : br;
  }
  if (['a', 'v'].includes(request.type)) {
    const bl = rounded(metrics.buffer * 1000, 100);
    current.bl = version === 2 ? `(${bl})` : bl;
  }
  if (metrics.throughput > 0) {
    const mtp = rounded(metrics.throughput / 1000, 100);
    current.mtp = version === 2 ? `(${mtp})` : mtp;
  }
  if (metrics.startup) current.su = '';
  const serialize = (values: Record<string, string>) =>
    Object.keys(values)
      .sort()
      .map((k) => (values[k] === '' ? k : `${k}=${values[k]}`))
      .join(',');
  return {
    query: serialize({ ...session, ...object, ...current }),
    headers: Object.fromEntries(
      [
        ['CMCD-Session', serialize(session)],
        ['CMCD-Object', serialize(object)],
        ['CMCD-Request', serialize(current)],
      ].filter(([, v]) => v),
    ),
  };
}
