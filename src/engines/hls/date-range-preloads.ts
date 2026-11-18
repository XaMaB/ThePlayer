import { timedDateRanges } from './date-ranges';
import { interstitialUrl } from './interstitials';
import type { Playlist } from './playlist';
import { ResourceClient, type ResourceResponse } from './network';
interface Entry {
  target: string;
  url: string;
  due: number;
  end: number;
  controller: AbortController;
  started: boolean;
  consumed: boolean;
  result?: ResourceResponse;
}
/** Bounded, optional Appendix F preloads; ordinary playback never waits on them. */
export class DateRangePreloads {
  private entries = new Map<string, Entry>();
  private active = 0;
  constructor(
    private client: ResourceClient,
    private session: string,
    private warning: (message: string) => void,
    private random = Math.random,
  ) {}
  update(playlist: Playlist, now: number) {
    if (!playlist.live) {
      this.clear();
      return;
    }
    const ranges = timedDateRanges(playlist),
      keep = new Set<string>();
    for (const range of ranges) {
      if (range.class !== 'com.apple.hls.preload') continue;
      try {
        const a = range.attributes;
        if (a['X-TARGET-CLASS'] !== 'com.apple.hls.interstitial') continue;
        if (
          !a['X-TARGET-ID'] ||
          !a['X-URI'] ||
          range.end === undefined ||
          range.cue.length ||
          range.endOnNext
        )
          throw new Error('Invalid interstitial preload date range');
        const target = ranges.find((r) => r.id === a['X-TARGET-ID']);
        if (target && target.class !== a['X-TARGET-CLASS']) continue;
        const raw = new URL(a['X-URI'], playlist.url);
        if (!['http:', 'https:'].includes(raw.protocol))
          throw new Error('Invalid preload URI');
        const url = interstitialUrl(raw.href, a['X-TARGET-ID'], this.session);
        if (target) {
          const uri =
            target.attributes['X-ASSET-URI'] ??
            target.attributes['X-ASSET-LIST'];
          if (
            !uri ||
            interstitialUrl(
              new URL(uri, playlist.url).href,
              target.id,
              this.session,
            ) !== url
          )
            continue;
        }
        const key = JSON.stringify([
          range.id,
          range.start,
          range.end,
          a['X-TARGET-ID'],
          url,
        ]);
        keep.add(key);
        const start = Math.max(now, range.start),
          end = Math.min(range.end, target?.start ?? range.end);
        const previous = this.entries.get(key);
        if (previous) {
          previous.end = end;
          previous.due = Math.min(previous.due, end);
          continue;
        }
        if (start >= end || this.entries.size >= 16) continue;
        this.entries.set(key, {
          target: a['X-TARGET-ID'],
          url,
          due: start + (end - start) * this.random(),
          end,
          controller: new AbortController(),
          started: false,
          consumed: false,
        });
      } catch (error) {
        this.warning(String(error));
      }
    }
    for (const [key, entry] of this.entries)
      if (!keep.has(key)) {
        entry.controller.abort();
        this.entries.delete(key);
      }
    this.tick(now);
  }
  tick(now: number) {
    for (const entry of this.entries.values()) {
      if (entry.started || entry.consumed || now < entry.due) continue;
      if (now >= entry.end) {
        entry.consumed = true;
        continue;
      }
      if (this.active >= 2) break;
      entry.started = true;
      this.active++;
      void this.client
        .get(
          { url: entry.url },
          {
            signal: entry.controller.signal,
            timeoutMs: 60000,
            retries: 0,
            recoveryWindowMs: 0,
            onProgress: (p) => {
              if (p.loaded > 1024 * 1024 || (p.total ?? 0) > 1024 * 1024)
                entry.controller.abort(
                  new Error('Preload resource exceeds 1 MiB'),
                );
            },
          },
        )
        .then((result) => {
          if (result.data.length > 1024 * 1024)
            throw new Error('Preload resource exceeds 1 MiB');
          if (!entry.controller.signal.aborted && !entry.consumed)
            entry.result = result;
        })
        .catch((error) => {
          if (!entry.controller.signal.aborted) this.warning(String(error));
        })
        .finally(() => this.active--);
    }
  }
  take(target: string, url: string): ResourceResponse | undefined {
    for (const entry of this.entries.values())
      if (entry.target === target && entry.url === url && !entry.consumed) {
        entry.consumed = true;
        const result = entry.result;
        entry.result = undefined;
        entry.controller.abort();
        return result;
      }
  }
  clear() {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
  }
}
