import { ResourceClient } from './network';
import type { Playlist, Resource } from './playlist';
type Result = Awaited<ReturnType<ResourceClient['get']>>;
const identity = (resource: Resource) =>
  JSON.stringify([resource.url, resource.range]);
/** Speculative bytes cannot enter MSE until an authoritative PART references them. */
export class PreloadCache {
  readonly diagnostics = { requested: 0, used: 0, cancelled: 0, missed: 0 };
  private entries = new Map<
    string,
    {
      owner: string;
      resource: Resource;
      abort: AbortController;
      result: Promise<Result | undefined>;
    }
  >();
  constructor(private client: ResourceClient) {}
  update(p: Playlist) {
    const announced = new Set(
      [...p.parts, ...(p.preload ? [p.preload] : [])].map(identity),
    );
    for (const [key, entry] of this.entries) {
      if (entry.owner === p.url && !announced.has(key)) {
        entry.abort.abort();
        this.entries.delete(key);
        this.diagnostics.cancelled++;
      }
    }
    if (!p.live || !p.preload || this.entries.has(identity(p.preload))) return;
    while (this.entries.size >= 4) {
      const [key, entry] = this.entries.entries().next().value!;
      entry.abort.abort();
      this.entries.delete(key);
      this.diagnostics.cancelled++;
    }
    const resource = p.preload,
      abort = new AbortController();
    let firstByte: number | undefined;
    this.diagnostics.requested++;
    const result = this.client
      .get(resource, {
        signal: abort.signal,
        recoveryWindowMs: 0,
        retries: 0,
        onProgress: (progress) => {
          if (progress.loaded && firstByte === undefined)
            firstByte = performance.now();
        },
      })
      .then((value) => ({
        ...value,
        elapsed:
          firstByte === undefined
            ? value.elapsed
            : Math.max(1, performance.now() - firstByte),
      }))
      .catch(() => undefined);
    this.entries.set(identity(resource), {
      owner: p.url,
      resource,
      abort,
      result,
    });
  }
  async take(resource: Resource) {
    const key = identity(resource),
      entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    const result = await entry.result;
    this.client.signal.throwIfAborted();
    if (result) this.diagnostics.used++;
    else this.diagnostics.missed++;
    return result;
  }
}
