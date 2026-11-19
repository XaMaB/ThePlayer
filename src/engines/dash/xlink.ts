import { duration, resolveUrl } from './mpd';
import type { DashResourceClient } from './network';
const ns = 'urn:mpeg:dash:schema:mpd:2011';
const xlink = 'http://www.w3.org/1999/xlink';
const xmlNs = 'http://www.w3.org/XML/1998/namespace';
const child = (e: Element, name: string) =>
  Array.from(e.children).filter(
    (c) => c.namespaceURI === ns && c.localName === name,
  );
function documentXml(xml: string) {
  if (xml.length > 4 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Unsafe DASH remote XML');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror'))
    throw new Error('Invalid DASH remote XML');
  if (doc.querySelectorAll('*').length > 150000)
    throw new Error('DASH remote element limit');
  return doc;
}
/** Resolve remote elements at access time. Retained decisions survive MPD refreshes. */
export class RemoteElements {
  readonly diagnostics = { requests: 0, resolved: 0, fallbacks: 0, removed: 0 };
  private cache = new Map<string, { xml: string; url: string }>();
  private cacheBytes = 0;
  constructor(private client: DashResourceClient) {}
  async resolve(xml: string, url: string, position?: number, refresh = true) {
    // onLoad is a decision for this MPD load; onRequest decisions are retained
    // while seeking back through the same Period.
    for (const [key, value] of this.cache) {
      if (refresh && JSON.parse(key)[4] === 'onLoad') {
        this.cache.delete(key);
        this.cacheBytes -= value.xml.length + key.length;
      }
    }
    const doc = documentXml(xml);
    const root = doc.documentElement;
    if (root.localName !== 'MPD' || root.namespaceURI !== ns)
      throw new Error('Expected DASH MPD');
    const live = root.getAttribute('type') === 'dynamic';
    position ??= live
      ? Math.max(
          0,
          (Date.now() -
            Date.parse(root.getAttribute('availabilityStartTime') ?? '')) /
            1000 -
            (duration(
              root.getAttribute('suggestedPresentationDelay') ?? undefined,
            ) ?? 12),
        )
      : 0;
    let requestCount = 0,
      bytes = xml.length;
    const visit = async (
      element: Element,
      base: string,
      periodStart: number,
      periodEnd: number,
      depth: number,
    ): Promise<void> => {
      if (depth > 5) throw new Error('DASH XLink nesting limit');
      const explicitBase = element.getAttributeNS(xmlNs, 'base');
      if (explicitBase) base = resolveUrl(explicitBase, base);
      const localBase = child(element, 'BaseURL')[0]?.textContent?.trim();
      const resourceBase = localBase ? resolveUrl(localBase, base) : base;
      const href = element.getAttributeNS(xlink, 'href');
      if (href !== null) {
        if (
          !['Period', 'AdaptationSet', 'SegmentList', 'EventStream'].includes(
            element.localName,
          )
        )
          throw new Error('Unsupported DASH XLink element');
        if (href === 'urn:mpeg:dash:resolve-to-zero:2013') {
          element.remove();
          this.diagnostics.removed++;
          return;
        }
        const actuate = element.getAttributeNS(xlink, 'actuate') ?? 'onRequest';
        if (!['onLoad', 'onRequest'].includes(actuate))
          throw new Error('Invalid DASH XLink actuate');
        const remoteUrl = resolveUrl(href, resourceBase);
        const serialized = new XMLSerializer().serializeToString(element);
        const key = JSON.stringify([
          url,
          periodStart,
          remoteUrl,
          serialized,
          actuate,
        ]);
        // Only Period placeholders can be deferred: their interval is known
        // without requiring the remote media or any advertisement decision.
        if (
          actuate === 'onRequest' &&
          element.localName === 'Period' &&
          !this.cache.has(key) &&
          (position! < periodStart || position! >= periodEnd)
        )
          return;
        try {
          let remote = this.cache.get(key);
          if (!remote) {
            if (++requestCount > 32)
              throw new Error('DASH XLink request limit');
            this.diagnostics.requests++;
            const response = await this.client.get(
              { url: remoteUrl },
              { timeoutMs: 5000, retries: 0, recoveryWindowMs: 0 },
            );

            remote = {
              xml: new TextDecoder('utf-8', { fatal: true }).decode(
                response.data,
              ),
              url: response.url,
            };
          }
          bytes += remote.xml.length;
          if (bytes > 4 * 1024 * 1024)
            throw new Error('DASH XLink aggregate size limit');
          // Remote entities can contain multiple siblings rather than one XML root.
          const fragment = documentXml(
            `<Remote xmlns="${ns}" xmlns:xlink="${xlink}" xmlns:cenc="urn:mpeg:cenc:2013">${remote.xml.replace(/^\s*<\?xml[^?]*\?>/, '')}</Remote>`,
          );
          const replacements = Array.from(fragment.documentElement.children);
          if (
            !replacements.length ||
            replacements.some(
              (e) => e.localName !== element.localName || e.namespaceURI !== ns,
            )
          )
            throw new Error('DASH XLink replacement type mismatch');
          const imported = replacements.map((e) => {
            const clone = doc.importNode(e, true);
            const declaredBase = clone.getAttributeNS(xmlNs, 'base');
            clone.setAttributeNS(
              xmlNs,
              'xml:base',
              declaredBase
                ? resolveUrl(declaredBase, remote!.url)
                : remote!.url,
            );
            return clone;
          });
          element.replaceWith(...imported);
          if (!this.cache.has(key)) {
            this.cache.set(key, remote);
            this.cacheBytes += remote.xml.length + key.length;
          }
          while (this.cache.size > 64 || this.cacheBytes > 8 * 1024 * 1024) {
            const oldest = this.cache.keys().next().value!;
            this.cacheBytes -=
              this.cache.get(oldest)!.xml.length + oldest.length;
            this.cache.delete(oldest);
          }
          this.diagnostics.resolved++;
          let nextStart = periodStart;
          for (let i = 0; i < imported.length; i++) {
            const replacement = imported[i];
            const isPeriod = replacement.localName === 'Period';
            const start = isPeriod
              ? (duration(replacement.getAttribute('start') ?? undefined) ??
                nextStart)
              : periodStart;
            const length = isPeriod
              ? duration(replacement.getAttribute('duration') ?? undefined)
              : undefined;
            const following = imported[i + 1];
            const end =
              length === undefined
                ? ((isPeriod && following
                    ? duration(following.getAttribute('start') ?? undefined)
                    : undefined) ?? periodEnd)
                : start + length;
            await visit(replacement, base, start, end, depth + 1);
            nextStart = end;
          }
          return;
        } catch (error) {
          this.client.signal.throwIfAborted();
          // A local default remains playable when a remote decision fails.
          // If there is no default, normal MPD validation rejects the empty lane.
          if (!element.parentNode) throw error;
          element.removeAttributeNS(xlink, 'href');
          element.removeAttributeNS(xlink, 'actuate');
          this.diagnostics.fallbacks++;
        }
      }
      for (const nested of Array.from(element.children))
        await visit(nested, resourceBase, periodStart, periodEnd, depth);
    };
    const periods = child(root, 'Period');
    let inferredStart = 0;
    const rootBase = child(root, 'BaseURL')[0]?.textContent?.trim();
    const documentBase = root.getAttributeNS(xmlNs, 'base');
    const inheritedBase = documentBase ? resolveUrl(documentBase, url) : url;
    const base = rootBase ? resolveUrl(rootBase, inheritedBase) : inheritedBase;
    for (let i = 0; i < periods.length; i++) {
      const period = periods[i];
      const start =
        duration(period.getAttribute('start') ?? undefined) ?? inferredStart;
      const length = duration(period.getAttribute('duration') ?? undefined);
      const nextStart =
        periods[i + 1] &&
        duration(periods[i + 1].getAttribute('start') ?? undefined);
      const end =
        length === undefined ? (nextStart ?? Infinity) : start + length;
      await visit(period, base, start, end, 0);
      inferredStart = end;
    }
    return new XMLSerializer().serializeToString(doc);
  }
}
