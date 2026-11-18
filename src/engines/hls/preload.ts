import { ResourceClient } from './network';
import type { Playlist, Resource } from './playlist';
type Result = Awaited<ReturnType<ResourceClient['get']>>;
const identity = (r: Resource) =>
  JSON.stringify([r.url, r.range, r.rangeStart]);
const covers = (hint: Resource, actual: Resource) =>
  identity(hint) === identity(actual) ||
  (hint.url === actual.url &&
    hint.rangeStart != null &&
    actual.range != null &&
    actual.range.offset >= hint.rangeStart);
interface Entry {
  owner: string;
  resource: Resource;
  abort: AbortController;
  result: Promise<Result | undefined>;
  chunks: Uint8Array[];
  size: number;
  url: string;
  firstByte?: number;
  done: boolean;
  waitMs: number;
  wake?: () => void;
}
/** Hint bytes enter MSE only after an authoritative PART or MAP references them. */
export class PreloadCache {
  readonly diagnostics = { requested: 0, used: 0, cancelled: 0, missed: 0 };
  private entries = new Map<string, Entry>();
  constructor(private client: ResourceClient) {}
  update(p: Playlist) {
    const hints = [p.preload, p.preloadMap].filter((r): r is Resource => !!r);
    const announced: Resource[] = [
      ...p.parts,
      ...hints,
      ...(p.nextMap ? [p.nextMap] : []),
      ...p.parts.flatMap((s) => (s.map ? [s.map] : [])),
      ...p.segments.flatMap((s) => (s.map ? [s.map] : [])),
    ];
    for (const [key, e] of this.entries) {
      if (e.owner === p.url && !announced.some((r) => covers(e.resource, r))) {
        e.abort.abort();
        this.entries.delete(key);
        this.diagnostics.cancelled++;
      }
    }
    if (!p.live) return;
    for (const resource of hints) {
      const key = identity(resource);
      if (this.entries.has(key)) continue;
      while (this.entries.size >= 4) {
        const [old, e] = this.entries.entries().next().value!;
        e.abort.abort();
        this.entries.delete(old);
        this.diagnostics.cancelled++;
      }
      const e: Entry = {
        owner: p.url,
        resource,
        abort: new AbortController(),
        result: Promise.resolve(undefined),
        chunks: [],
        size: 0,
        url: resource.url,
        done: false,
        waitMs: Math.max(250, Math.min(5000, (p.partTarget ?? 1) * 2000)),
      };
      this.diagnostics.requested++;
      e.result = this.client
        .get(resource, {
          signal: e.abort.signal,
          recoveryWindowMs: 0,
          retries: 0,
          onProgress: (p) => {
            if (p.loaded && e.firstByte == null)
              e.firstByte = performance.now();
          },
          onChunk: (bytes, url) => {
            e.chunks.push(bytes);
            e.size += bytes.length;
            e.url = url;
            e.wake?.();
          },
        })
        .then((value) => ({
          ...value,
          elapsed:
            e.firstByte == null
              ? value.elapsed
              : Math.max(1, performance.now() - e.firstByte),
        }))
        .catch(() => undefined)
        .finally(() => {
          e.done = true;
          e.wake?.();
        });
      this.entries.set(key, e);
    }
  }
  async take(resource: Resource) {
    const pair = [...this.entries].find(([, e]) =>
      covers(e.resource, resource),
    );
    if (!pair) return;
    const [key, e] = pair;
    this.entries.delete(key);
    let result: Result | undefined;
    if (e.resource.rangeStart != null && resource.range) {
      const start = resource.range.offset - e.resource.rangeStart,
        length = resource.range.length,
        end = start + length;
      if (!Number.isSafeInteger(end) || end > 64 * 1024 * 1024) {
        e.abort.abort();
        this.diagnostics.missed++;
        return;
      }
      // Fetch exposes chunks before a growing resource closes. XHR falls back
      // to a completed response or an authoritative bounded-range request.
      if (e.size < end && !e.done && this.client.options.transport !== 'xhr')
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, e.waitMs);
          const stop = () => finish();
          function finish() {
            clearTimeout(timer);
            e.wake = undefined;
            e.abort.signal.removeEventListener('abort', stop);
            resolve();
          }
          e.wake = () => {
            if (e.size >= end || e.done) finish();
          };
          e.abort.signal.addEventListener('abort', stop, { once: true });
        });
      if (e.size >= end) {
        const data = new Uint8Array(length);
        let offset = 0;
        for (const chunk of e.chunks) {
          const a = Math.max(start - offset, 0),
            b = Math.min(end - offset, chunk.length);
          if (b > a)
            data.set(chunk.subarray(a, b), Math.max(offset - start, 0));
          offset += chunk.length;
          if (offset >= end) break;
        }
        result = {
          receivedAt: performance.now(),
          data,
          url: e.url,
          elapsed: Math.max(
            1,
            performance.now() - (e.firstByte ?? performance.now()),
          ),
        };
      } else if (e.done) {
        const full = await e.result;
        if (full && full.data.length >= end)
          result = { ...full, data: full.data.slice(start, end) };
      }
      e.abort.abort();
    } else result = await e.result;
    this.client.signal.throwIfAborted();
    if (result) this.diagnostics.used++;
    else this.diagnostics.missed++;
    return result;
  }
}
