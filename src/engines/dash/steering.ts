import { replaceUri } from '../hls/steering';
import { HttpError } from '../hls/recovery';
import type { DashResource, DashResourceClient } from './network';
import type { Manifest } from './model';
interface Clone {
  id: string;
  base: string;
  replacement: Record<string, unknown>;
}
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 8192)
    throw new Error('Invalid DASH steering string');
  return value;
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new Error('Invalid DASH steering object');
  return v as Record<string, unknown>;
};
export function parseDashSteering(value: unknown, url: string) {
  const m = object(value);
  if (m.VERSION !== 1) throw new Error('Unsupported DASH steering version');
  if (typeof m.TTL !== 'number' || !Number.isFinite(m.TTL) || m.TTL < 0)
    throw new Error('Invalid DASH steering TTL');
  const ids = m['PATHWAY-PRIORITY'] ?? [];
  if (
    !Array.isArray(ids) ||
    ids.length > 128 ||
    (m['PATHWAY-PRIORITY'] !== undefined && !ids.length)
  )
    throw new Error('Invalid DASH steering priority');
  const priority = ids.map(text);
  if (new Set(priority).size !== priority.length)
    throw new Error('Duplicate DASH steering priority');
  const raw = m['PATHWAY-CLONES'] ?? [];
  if (!Array.isArray(raw) || raw.length > 64)
    throw new Error('Invalid DASH steering clones');
  const seen = new Set<string>();
  const clones: Clone[] = raw.map((v) => {
    const c = object(v),
      id = text(c.ID),
      base = text(c['BASE-ID']),
      replacement = object(c['URI-REPLACEMENT']);
    if (seen.has(id) || id === base)
      throw new Error('Duplicate DASH steering clone');
    seen.add(id);
    replaceUri('https://example.com/media', replacement);
    return { id, base, replacement };
  });
  let reload: string | undefined;
  if (m['RELOAD-URI'] !== undefined) {
    reload = new URL(text(m['RELOAD-URI']), url).href;
    if (!/^https?:/.test(reload))
      throw new Error('Invalid DASH steering reload URI');
  }
  return { priority, clones, reload, ttl: m.TTL };
}
export class DashSteering {
  readonly diagnostics = {
    requests: 0,
    pathway: '',
    warning: '',
    disabled: false,
  };
  private priority: string[];
  private clones: Clone[] = [];
  private next = 0;
  private ttl = 300;
  private url: string;
  private valid = false;
  private penalties = new Map<string, number>();
  constructor(
    readonly config: NonNullable<Manifest['steering']>,
    private client: DashResourceClient,
  ) {
    this.priority = config.defaults;
    this.url = config.url;
  }
  async refresh(ready: boolean, throughput: number) {
    if (
      this.diagnostics.disabled ||
      performance.now() < this.next ||
      (!this.config.queryBeforeStart && !ready)
    )
      return;
    const url = new URL(this.url);
    if (this.diagnostics.pathway) {
      url.searchParams.set('_DASH_pathway', this.diagnostics.pathway);
      if (throughput > 0)
        url.searchParams.set(
          '_DASH_throughput',
          String(Math.round(throughput)),
        );
    }
    this.diagnostics.requests++;
    try {
      const response = await this.client.get(
        { url: url.href },
        { timeoutMs: 3000, retries: 0, recoveryWindowMs: 0 },
      );
      if (response.data.length > 1024 * 1024)
        throw new Error('DASH steering size limit');
      const result = parseDashSteering(
        JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(response.data),
        ),
        response.url,
      );
      this.priority = result.priority;
      this.clones = result.clones;
      this.ttl = result.ttl;
      this.valid = true;
      this.url = result.reload ?? response.url;
      this.diagnostics.warning = '';
      this.next = performance.now() + Math.max(0.1, this.ttl) * 1000;
    } catch (error) {
      this.client.signal.throwIfAborted();
      this.diagnostics.warning = (error as Error).message;
      if (
        (error instanceof HttpError && error.status === 410) ||
        /Unsupported DASH steering version/.test(this.diagnostics.warning)
      ) {
        this.diagnostics.disabled = true;
        if (!this.valid) this.priority = [];
      }
      const retry =
        error instanceof HttpError && error.status === 429
          ? error.retryAfter
            ? /^\d+$/.test(error.retryAfter)
              ? Number(error.retryAfter) * 1000
              : Math.max(0, Date.parse(error.retryAfter) - Date.now())
            : undefined
          : undefined;
      this.next =
        performance.now() +
        (retry !== undefined && Number.isFinite(retry)
          ? retry
          : Math.max(1, this.ttl) * 1000);
    }
  }
  candidates(resource: DashResource): { url: string; id: string }[] {
    const all = [resource.url, ...(resource.alternatives ?? [])].map(
      (url, i) => ({ url, id: resource.serviceLocations?.[i] ?? '' }),
    );
    if (!all.some((v) => v.id)) return all;
    for (const clone of this.clones) {
      if (all.some((v) => v.id === clone.id)) continue;
      all.push(
        ...all
          .filter((v) => v.id === clone.base)
          .map((v) => ({
            url: replaceUri(v.url, clone.replacement),
            id: clone.id,
          })),
      );
      if (all.length > 128) throw new Error('DASH steering candidate limit');
    }
    const rank = (id: string) => {
      const at = this.priority.indexOf(id);
      return at < 0 ? Infinity : at;
    };
    let candidates =
      this.valid && this.priority.length
        ? all.filter((v) => rank(v.id) < Infinity)
        : all;
    // No eligible pathway: retain the resource for an unsteered scope only.
    if (!candidates.length)
      throw new Error('No eligible DASH steering service location');
    candidates = candidates.filter(
      (v) => (this.penalties.get(v.id) ?? 0) <= performance.now(),
    );
    if (!candidates.length)
      throw new Error(
        'All DASH steering service locations are temporarily unavailable',
      );
    return candidates.sort((a, b) => rank(a.id) - rank(b.id));
  }
  success(id: string) {
    if (id) this.diagnostics.pathway = id;
  }
  failure(id: string) {
    if (!id) return;
    this.penalties.set(id, performance.now() + Math.max(1, this.ttl) * 1000);
    while (this.penalties.size > 128)
      this.penalties.delete(this.penalties.keys().next().value!);
  }
}
