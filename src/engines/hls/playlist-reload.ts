import { PreloadCache } from './preload';
import {
  MissingDeltaBase,
  parsePlaylist,
  playablePlaylist,
  type Playlist,
  type Attributes,
} from './playlist';
import { ResourceClient } from './network';
import { HttpError } from './recovery';

/** Delivery directives are opt-in per playlist, never an unconditional cache buster. */
export function reloadUrl(
  previous: Playlist,
  ageMs: number,
  blocking = true,
): string {
  const url = new URL(previous.url);
  for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip'])
    url.searchParams.delete(name);
  if (!previous.live) return url.href;
  if (blocking && previous.serverControl?.['CAN-BLOCK-RELOAD'] === 'YES') {
    const tail = previous.segments.at(-1)!;
    url.searchParams.set(
      '_HLS_msn',
      String(tail.part === undefined ? tail.sequence + 1 : tail.sequence),
    );
    if (previous.partTarget)
      url.searchParams.set(
        '_HLS_part',
        String(tail.part === undefined ? 0 : tail.part + 1),
      );
  }
  const skip = Number(previous.serverControl?.['CAN-SKIP-UNTIL']);
  if (skip >= 6 * previous.targetDuration && ageMs <= skip * 500)
    url.searchParams.set('_HLS_skip', 'YES');
  return url.href;
}
export function canonicalPlaylistUrl(value: string) {
  const url = new URL(value);
  for (const name of ['_HLS_msn', '_HLS_part', '_HLS_skip'])
    url.searchParams.delete(name);
  return url.href;
}
export class PlaylistLoader {
  readonly diagnostics = {
    blocking: 0,
    delta: 0,
    fullReloads: 0,
    directiveFallbacks: 0,
    renditionReports: 0,
  };
  readonly preload: PreloadCache;
  private disabled = new Map<string, number>();
  constructor(
    private client: ResourceClient,
    private inherited: () => Attributes,
  ) {
    this.preload = new PreloadCache(client);
  }
  blocking(p: Playlist) {
    return (
      p.live &&
      p.serverControl?.['CAN-BLOCK-RELOAD'] === 'YES' &&
      (this.disabled.get(p.url) ?? 0) <= performance.now()
    );
  }
  private parse(data: Uint8Array, url: string, previous?: Playlist) {
    if (data.length > 2 * 1024 * 1024)
      throw new Error('Playlist exceeds 2 MiB');
    const p = parsePlaylist(
      new TextDecoder('utf-8', { fatal: true }).decode(data),
      canonicalPlaylistUrl(url),
      this.inherited(),
      previous,
    );
    if (p.unsupported.length)
      throw new Error('Unsupported HLS feature: ' + p.unsupported.join(', '));
    this.preload.update(p);
    return playablePlaylist(p);
  }
  async read(url: string, recoveryWindowMs?: number) {
    const response = await this.client.get({ url }, { recoveryWindowMs });
    return this.parse(response.data, response.url);
  }
  async rendition(url: string, reference: Playlist, recoveryWindowMs?: number) {
    const report = reference.reports?.find(
      (report) => report.url === canonicalPlaylistUrl(url),
    );
    if (!report || report.sequence === undefined || !this.blocking(reference))
      return this.read(url, recoveryWindowMs);
    const request = new URL(url);
    request.searchParams.set('_HLS_msn', String(report.sequence));
    if (report.part !== undefined)
      request.searchParams.set('_HLS_part', String(report.part));
    this.diagnostics.renditionReports++;
    try {
      return await this.read(request.href, 0);
    } catch (error) {
      this.client.signal.throwIfAborted();
      if (error instanceof HttpError && [400, 412, 503].includes(error.status))
        return this.read(url, recoveryWindowMs);
      throw error;
    }
  }
  async reload(previous: Playlist, ageMs: number) {
    const now = performance.now();
    const url = reloadUrl(
      previous,
      ageMs,
      (this.disabled.get(previous.url) ?? 0) <= now,
    );
    const blocking = new URL(url).searchParams.has('_HLS_msn');
    if (blocking) this.diagnostics.blocking++;
    try {
      const response = await this.client.get(
        { url },
        {
          recoveryWindowMs: blocking ? 0 : undefined,
          retries: blocking ? 0 : undefined,
          timeoutMs: blocking
            ? (this.client.options.timeoutMs ??
              Math.max(15000, previous.targetDuration * 3000 + 1000))
            : undefined,
        },
      );
      const p = this.parse(response.data, response.url, previous);
      if (p.skipped !== undefined) this.diagnostics.delta++;
      return p;
    } catch (error) {
      this.client.signal.throwIfAborted();
      if (error instanceof MissingDeltaBase) this.diagnostics.fullReloads++;
      else if (
        url !== previous.url &&
        ((error instanceof HttpError &&
          [400, 412, 503].includes(error.status)) ||
          (error instanceof Error && error.name === 'TimeoutError'))
      ) {
        this.diagnostics.directiveFallbacks++;
        if (this.disabled.size >= 64) this.disabled.clear();
        this.disabled.set(previous.url, now + 30000);
      } else throw error;
      return this.read(canonicalPlaylistUrl(previous.url));
    }
  }
}
