import {
  cmcd,
  type CmcdOptions,
  type ClientMetrics,
  type MediaRequest,
} from './telemetry';
import { DashSteering } from './steering';
import type { Manifest } from './model';
import {
  ResourceClient,
  type ResourceResponse,
  type RequestOptions,
} from '../hls/network';
import { retryable } from '../hls/recovery';
import type { Resource } from '../hls/playlist';
export interface DashResource extends Resource {
  telemetry?: MediaRequest;
  alternatives?: string[];
  serviceLocations?: string[];
}
/** Try MPD-declared mirrors only; credentials remain scoped by the resource client. */
export class DashResourceClient extends ResourceClient {
  readonly delivery = {
    switches: 0,
    failures: 0,
    origin: '',
    notModified: 0,
    cmsd: {} as { static?: string; dynamic?: string },
  };
  steering?: DashSteering;
  telemetry?: { options: CmcdOptions; metrics: () => ClientMetrics };
  configure(manifest: Manifest) {
    if (!manifest.steering) {
      this.steering = undefined;
      return;
    }
    if (
      JSON.stringify(this.steering?.config) !==
      JSON.stringify(manifest.steering)
    )
      this.steering = new DashSteering(manifest.steering, this);
  }
  private manifests = new Map<string, ResourceResponse>();
  async manifest(
    url: string,
    options: RequestOptions = {},
    resource: DashResource = { url },
  ) {
    resource = { ...resource, telemetry: { type: 'm' } };
    const cached = this.manifests.get(url);
    const headers: Record<string, string> = {};
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    else if (cached?.lastModified)
      headers['If-Modified-Since'] = cached.lastModified;
    let result = await this.get(resource, {
      ...options,
      headers,
      acceptNotModified: !!cached,
    });
    if (result.status === 304) {
      if (!cached || result.url !== cached.url) {
        result = await this.get(resource, options);
      } else {
        this.delivery.notModified++;
        result = {
          ...cached,
          ...result,
          data: cached.data,
          etag: result.etag ?? cached.etag,
          lastModified: result.lastModified ?? cached.lastModified,
        };
      }
    }
    if (result.data.length > 4 * 1024 * 1024)
      throw new Error('DASH MPD exceeds 4 MiB');
    this.manifests.set(url, result);
    while (this.manifests.size > 4)
      this.manifests.delete(this.manifests.keys().next().value!);
    return result;
  }
  private penalties = new Map<string, number>();
  override async get(resource: DashResource, options: RequestOptions = {}) {
    const candidates =
      this.steering?.candidates(resource) ??
      [resource.url, ...(resource.alternatives ?? [])].map((url, i) => ({
        url,
        id: resource.serviceLocations?.[i] ?? '',
      }));
    const urls = [...new Set(candidates.map((c) => c.url))];
    if (urls.length > 128) throw new Error('DASH BaseURL alternative limit');
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
        let requestUrl = url;
        let headers = options.headers;
        if (resource.telemetry && this.telemetry) {
          const report = cmcd(
            this.telemetry.options,
            resource.telemetry,
            this.telemetry.metrics(),
          );
          if (this.telemetry.options.mode === 'headers')
            headers = { ...headers, ...report.headers };
          else {
            const u = new URL(url);
            u.searchParams.set('CMCD', report.query);
            requestUrl = u.href;
          }
        }
        const result = await super.get(
          { ...resource, url: requestUrl },
          {
            ...options,
            headers,
            retries: urls.length > 1 || options.onChunk ? 0 : options.retries,
            recoveryWindowMs:
              urls.length > 1 || options.onChunk ? 0 : options.recoveryWindowMs,
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
        if (result.cmsd?.static || result.cmsd?.dynamic)
          this.delivery.cmsd = result.cmsd;
        this.steering?.success(candidates.find((c) => c.url === url)?.id ?? '');
        return result;
      } catch (error) {
        this.signal.throwIfAborted();
        options.signal?.throwIfAborted();
        if (!retryable(error) || delivered) throw error;
        this.delivery.failures++;
        this.steering?.failure(candidates.find((c) => c.url === url)?.id ?? '');
        this.penalties.set(new URL('.', url).href, performance.now() + 5000);
        while (this.penalties.size > 64)
          this.penalties.delete(this.penalties.keys().next().value!);
        last = error;
      }
    }
    throw last;
  }
}
