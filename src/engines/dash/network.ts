import { ResourceClient, type RequestOptions } from '../hls/network';
import { retryable } from '../hls/recovery';
import type { Resource } from '../hls/playlist';
export interface DashResource extends Resource {
  alternatives?: string[];
}
/** Try MPD-declared mirrors only; credentials remain scoped by the resource client. */
export class DashResourceClient extends ResourceClient {
  readonly delivery = { switches: 0, failures: 0, origin: '' };
  private penalties = new Map<string, number>();
  override async get(resource: DashResource, options: RequestOptions = {}) {
    const urls = [...new Set([resource.url, ...(resource.alternatives ?? [])])];
    if (urls.length === 1) return super.get(resource, options);
    if (urls.length > 32) throw new Error('DASH BaseURL alternative limit');
    urls.sort(
      (a, b) =>
        Number(
          (this.penalties.get(new URL('.', a).href) ?? 0) > performance.now(),
        ) -
        Number(
          (this.penalties.get(new URL('.', b).href) ?? 0) > performance.now(),
        ),
    );
    let last: unknown;
    for (const url of urls) {
      this.signal.throwIfAborted();
      options.signal?.throwIfAborted();
      let delivered = false;
      try {
        const result = await super.get(
          { ...resource, url },
          {
            ...options,
            retries: 0,
            recoveryWindowMs: 0,
            onChunk: options.onChunk
              ? (data, finalUrl) => {
                  delivered = true;
                  options.onChunk!(data, finalUrl);
                }
              : undefined,
          },
        );
        if (url !== resource.url) this.delivery.switches++;
        this.delivery.origin = new URL(result.url).origin;
        return result;
      } catch (error) {
        this.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        if (!retryable(error) || delivered) throw error;
        this.delivery.failures++;
        this.penalties.set(new URL('.', url).href, performance.now() + 5000);
        while (this.penalties.size > 64)
          this.penalties.delete(this.penalties.keys().next().value!);
        last = error;
      }
    }
    throw last;
  }
}
