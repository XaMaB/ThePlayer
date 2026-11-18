import type { Playlist, Variant, Rendition } from './playlist';
import { ResourceClient } from './network';
import { HttpError } from './recovery';
interface Pathway {
  variants: Variant[];
  renditions: Rendition[];
}
interface Manifest {
  ttl: number;
  reload?: string;
  priority: string[];
  pathways: Map<string, Pathway>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid steering object');
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (typeof value !== 'string' || !value || value.length > 8192)
    throw new Error('Invalid steering string');
  return value;
};
function http(value: string, base?: string) {
  const u = new URL(value, base);
  if (!['http:', 'https:'].includes(u.protocol))
    throw new Error('Invalid steering media URI');
  return u.href;
}
export function pathways(master: Playlist) {
  const result = new Map<string, Pathway>();
  for (const v of master.variants) {
    const id = v.pathway ?? '';
    let p = result.get(id);
    if (!p) {
      p = { variants: [], renditions: [] };
      result.set(id, p);
    }
    p.variants.push(v);
  }
  for (const p of result.values()) {
    const groups = new Set(
      p.variants.flatMap((v) => [v.audio, v.subtitles, v.closedCaptions]),
    );
    p.renditions = master.renditions.filter((r) => groups.has(r.group));
  }
  return result;
}
function replaceUri(uri: string, replacement: Record<string, unknown>) {
  const u = new URL(uri);
  if (replacement.HOST !== undefined) {
    const host = text(replacement.HOST);
    if (/[/?#@\\]/.test(host)) throw new Error('Invalid steering HOST');
    const candidate = new URL(u.protocol + '//' + host);
    if (candidate.username || candidate.password || candidate.pathname !== '/')
      throw new Error('Invalid steering HOST');
    u.host = candidate.host;
  }
  if (replacement.PARAMS !== undefined) {
    const params = object(replacement.PARAMS),
      encoder = new TextEncoder();
    const keys = Object.keys(params).sort((a, b) => {
      const x = encoder.encode(a),
        y = encoder.encode(b);
      for (let i = 0; i < Math.min(x.length, y.length); i++)
        if (x[i] !== y[i]) return x[i] - y[i];
      return x.length - y.length;
    });
    if (keys.length > 128) throw new Error('Too many steering parameters');
    let query = u.search.slice(1).split('&').filter(Boolean);
    for (const k of keys) {
      const v = params[k];
      if (
        !k ||
        typeof v !== 'string' ||
        !/^(?:[A-Za-z0-9._~-]|%[0-9a-fA-F]{2})*$/.test(k) ||
        !/^(?:[A-Za-z0-9._~-]|%[0-9a-fA-F]{2})*$/.test(v)
      )
        throw new Error('Steering parameters must be percent-encoded');
      const name = decodeURIComponent(k);
      decodeURIComponent(v);
      query = query.filter((part) => {
        try {
          return (
            decodeURIComponent(part.split('=')[0].replace(/\+/g, ' ')) !== name
          );
        } catch {
          return true;
        }
      });
      query.push(k + '=' + v);
    }
    u.search = query.join('&');
  }
  return u.href;
}
export function parseSteering(
  data: unknown,
  base: string,
  master: Playlist,
): Manifest {
  const m = object(data);
  if (m.VERSION !== 1 || !Number.isSafeInteger(m.TTL) || (m.TTL as number) < 0)
    throw new Error('Unsupported steering version or TTL');
  if (
    !Array.isArray(m['PATHWAY-PRIORITY']) ||
    !m['PATHWAY-PRIORITY'].length ||
    m['PATHWAY-PRIORITY'].length > 128
  )
    throw new Error('Invalid steering priority');
  const priority = m['PATHWAY-PRIORITY'].map(text);
  if (new Set(priority).size !== priority.length)
    throw new Error('Duplicate steering priority');
  const result = pathways(master);
  const clones = m['PATHWAY-CLONES'];
  if (clones !== undefined) {
    if (!Array.isArray(clones) || !clones.length || clones.length > 64)
      throw new Error('Invalid steering clones');
    for (const raw of clones) {
      const clone = object(raw),
        id = text(clone.ID),
        baseId = text(clone['BASE-ID']),
        replacement = object(clone['URI-REPLACEMENT']);
      if (result.has(id)) throw new Error('Duplicate steering pathway');
      const original = result.get(baseId);
      if (!original) continue;
      const variants =
        replacement['PER-VARIANT-URIS'] === undefined
          ? {}
          : object(replacement['PER-VARIANT-URIS']);
      const renditions =
        replacement['PER-RENDITION-URIS'] === undefined
          ? {}
          : object(replacement['PER-RENDITION-URIS']);
      for (const value of [
        ...Object.values(variants),
        ...Object.values(renditions),
      ])
        http(text(value));
      const groups = new Map(
        original.renditions.map((r) => [r.group, `steering:${id}:${r.group}`]),
      );
      const group = (name?: string) =>
        name ? (groups.get(name) ?? name) : name;
      result.set(id, {
        variants: original.variants.map((v) => ({
          ...v,
          pathway: id,
          audio: group(v.audio),
          subtitles: group(v.subtitles),
          closedCaptions: group(v.closedCaptions),
          url:
            v.stableId && Object.hasOwn(variants, v.stableId)
              ? http(text(variants[v.stableId]))
              : replaceUri(v.url, replacement),
        })),
        renditions: original.renditions.map((r) => ({
          ...r,
          group: group(r.group)!,
          url: r.url
            ? r.stableId && Object.hasOwn(renditions, r.stableId)
              ? http(text(renditions[r.stableId]))
              : replaceUri(r.url, replacement)
            : undefined,
        })),
      });
    }
  }
  const reload =
    m['RELOAD-URI'] === undefined
      ? undefined
      : new URL(text(m['RELOAD-URI']), base).href;
  if (
    reload &&
    !['http:', 'https:', 'data:'].includes(new URL(reload).protocol)
  )
    throw new Error('Invalid steering reload URI');
  return {
    ttl: m.TTL as number,
    reload,
    priority: priority.filter((id) => result.has(id)),
    pathways: result,
  };
}
export class ContentSteering {
  readonly diagnostics = {
    pathway: '',
    requests: 0,
    switches: 0,
    warning: '',
    penalized: [] as string[],
  };
  private known: Map<string, Pathway>;
  private priority: string[];
  private penalties = new Map<string, number>();
  private uri: string;
  private ttl = 300;
  private next = 0;
  private disabled = false;
  constructor(
    private master: Playlist,
    private client: ResourceClient,
  ) {
    this.known = pathways(master);
    this.priority = [...this.known.keys()];
    const initial = master.steering?.pathway;
    if (initial !== undefined && this.known.has(initial))
      this.priority = [
        initial,
        ...this.priority.filter((id) => id !== initial),
      ];
    this.diagnostics.pathway = this.priority[0] ?? '';
    this.uri = master.steering!.url;
  }
  catalog() {
    const p = this.known.get(this.diagnostics.pathway);
    if (!p) throw new Error('No steering pathway');
    return { ...this.master, variants: p.variants, renditions: p.renditions };
  }
  penalize(now = performance.now()) {
    this.penalties.set(this.diagnostics.pathway, now + 120000);
    this.evaluate(now);
  }
  private evaluate(now: number) {
    for (const [id, until] of this.penalties)
      if (until <= now) this.penalties.delete(id);
    const next = this.priority.find(
      (id) => this.known.has(id) && !this.penalties.has(id),
    );
    if (next !== undefined && next !== this.diagnostics.pathway) {
      this.diagnostics.pathway = next;
      this.diagnostics.switches++;
    }
    this.diagnostics.penalized = [...this.penalties.keys()];
  }
  async refresh(throughput: number, now = performance.now()) {
    if (!this.disabled && now >= this.next) {
      this.diagnostics.requests++;
      let retryMs: number | undefined;
      try {
        let data: Uint8Array,
          url = this.uri;
        if (this.uri.startsWith('data:')) {
          const match =
            /^data:application\/(?:json|vnd\.apple\.steering-list)(?:;charset=utf-8)?(;base64)?,(.*)$/i.exec(
              this.uri,
            );
          if (!match) throw new Error('Unsupported inline steering manifest');
          const body = match[1] ? atob(match[2]) : decodeURIComponent(match[2]);
          data = match[1]
            ? Uint8Array.from(body, (c) => c.charCodeAt(0))
            : new TextEncoder().encode(body);
        } else {
          const request = new URL(this.uri);
          request.searchParams.set('_HLS_pathway', this.diagnostics.pathway);
          if (throughput > 0)
            request.searchParams.set(
              '_HLS_throughput',
              String(Math.round(throughput)),
            );
          const r = await this.client.get(
            { url: request.href },
            { timeoutMs: 3000, retries: 0, recoveryWindowMs: 0 },
          );
          data = r.data;
          url = r.url;
        }
        if (data.length > 1024 * 1024)
          throw new Error('Steering manifest exceeds 1 MiB');
        const parsed = parseSteering(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)),
          url,
          this.master,
        );
        const current = this.known.get(this.diagnostics.pathway);
        this.known = parsed.pathways;
        if (
          current &&
          !this.known.has(this.diagnostics.pathway) &&
          !parsed.priority.some((id) => !this.penalties.has(id))
        )
          this.known.set(this.diagnostics.pathway, current);
        this.priority = parsed.priority;
        this.ttl = parsed.ttl;
        this.uri = parsed.reload ?? this.uri;
        this.diagnostics.warning = '';
      } catch (error) {
        this.client.signal.throwIfAborted();
        if (error instanceof HttpError && error.status === 410)
          this.disabled = true;
        if (
          error instanceof HttpError &&
          error.status === 429 &&
          error.retryAfter
        ) {
          const seconds = Number(error.retryAfter);
          const delay = Number.isFinite(seconds)
            ? seconds * 1000
            : Date.parse(error.retryAfter) - Date.now();
          if (Number.isFinite(delay) && delay >= 0) retryMs = delay;
        }
        this.diagnostics.warning =
          error instanceof Error ? error.message : String(error);
      }
      this.next = performance.now() + Math.max(250, retryMs ?? this.ttl * 1000);
    }
    this.evaluate(now);
  }
}
