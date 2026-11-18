import {
  parsePlaylist,
  type Playlist,
  type Segment,
  type Variant,
  type Resource,
  type Key,
} from './playlist';
import { alignRendition } from './renditions';
import { MediaLane, type LoadedResource } from './media-lane';
import type { ResourceClient } from './network';
import { decodePreview } from './preview-frame';
import { decryptCbcBlocks } from './sample-aes';
import type { Thumbnail } from '../../core/thumbnail';

/** RFC 8216bis 6.3.6: CBC byte ranges include the preceding ciphertext block. */
export function widenedCbcRange(offset: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    !Number.isSafeInteger(offset + length)
  )
    throw new Error('Invalid encrypted preview range');
  const first = Math.floor(offset / 16) * 16,
    end = Math.ceil((offset + length) / 16) * 16;
  const start = Math.max(0, first - 16);
  return {
    offset: start,
    length: end - start,
    skip: offset - first,
    prefix: first - start,
  };
}
export class IFrameThumbnails {
  private playlist?: Playlist;
  private refreshedAt = 0;
  private loading?: Promise<Playlist>;
  private cache = new Map<string, Thumbnail>();
  private pending = new Map<string, Promise<Thumbnail>>();
  private closed = false;
  constructor(
    private variant: Variant,
    private client: ResourceClient,
    private reference: () => Playlist,
    private variables: () => Record<string, string>,
    private decrypt: (
      data: Uint8Array,
      key: Key | undefined,
      sequence: number,
    ) => Promise<Uint8Array>,
    private cbcKey: (key: Key) => Promise<CryptoKey>,
    private sampleDecrypt: ConstructorParameters<typeof MediaLane>[5],
  ) {}
  private async read() {
    if (
      this.playlist &&
      (!this.playlist.live ||
        performance.now() - this.refreshedAt <
          this.playlist.targetDuration * 1000)
    )
      return this.playlist;
    this.loading ??= (async () => {
      const response = await this.client.get(
        { url: this.variant.url },
        { recoveryWindowMs: 0, retries: 0, timeoutMs: 5000 },
      );
      if (response.data.length > 2 * 1024 * 1024)
        throw new Error('I-frame playlist exceeds limit');
      const p = parsePlaylist(
        new TextDecoder('utf-8', { fatal: true }).decode(response.data),
        response.url,
        this.variables(),
      );
      if (!p.iframesOnly || p.unsupported.length)
        throw new Error('Expected I-FRAMES-ONLY playlist');
      if (
        p.live &&
        (!p.segments.some((s) => s.programDateTime) ||
          !this.reference().segments.some((s) => s.programDateTime))
      )
        throw new Error('Live I-frame previews require PROGRAM-DATE-TIME');
      this.playlist = alignRendition(p, this.reference());
      this.refreshedAt = performance.now();
      return this.playlist;
    })();
    const loading = this.loading;
    try {
      return await loading;
    } finally {
      if (this.loading === loading) this.loading = undefined;
    }
  }
  private async load(
    resource: Resource,
    key: Key | undefined,
    sequence: number,
  ): Promise<LoadedResource> {
    if (key?.method === 'AES-128' && resource.range) {
      if (key.format !== 'identity')
        throw new Error('Unsupported I-frame key format');
      const range = widenedCbcRange(
        resource.range.offset,
        resource.range.length,
      );
      const loaded = await this.client.get(
        {
          url: resource.url,
          range: { offset: range.offset, length: range.length },
        },
        { recoveryWindowMs: 0, retries: 0, timeoutMs: 5000 },
      );
      let iv = key.iv ?? new Uint8Array(16);
      if (range.prefix) iv = loaded.data.slice(0, 16);
      else if (!key.iv)
        new DataView(iv.buffer).setBigUint64(8, BigInt(sequence));
      const bytes = await decryptCbcBlocks(
        loaded.data.subarray(range.prefix),
        await this.cbcKey(key),
        iv,
      );
      return {
        ...loaded,
        data: bytes.slice(range.skip, range.skip + resource.range.length),
      };
    }
    const loaded = await this.client.get(resource, {
      recoveryWindowMs: 0,
      retries: 0,
      timeoutMs: 5000,
    });
    if (['SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(key?.method ?? ''))
      return loaded;
    return { ...loaded, data: await this.decrypt(loaded.data, key, sequence) };
  }
  async get(time: number): Promise<Thumbnail | undefined> {
    if (!Number.isFinite(time) || time < 0)
      throw new Error('Invalid thumbnail time');
    if (this.closed) return;
    const playlist = await this.read();
    if (this.closed) return;
    const original = playlist.segments.find(
      (s) => time >= s.start && time < s.start + s.duration,
    );
    if (!original || original.gap) return;
    const key = JSON.stringify([
      original.url,
      original.sequence,
      original.discontinuity,
      original.range,
      original.map,
      original.key,
    ]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return {
        ...cached,
        time: original.start,
        end: original.start + original.duration,
      };
    }
    let pending = this.pending.get(key);
    if (!pending) {
      if (this.pending.size >= 2) return;
      pending = (async () => {
        let map = original.map;
        let mapSequence = original.sequence;
        if (!map && original.range && original.range.offset > 0) {
          const first = playlist.segments.find(
            (s) =>
              s.url === original.url &&
              s.discontinuity === original.discontinuity,
          )!;
          if (!first.range?.offset)
            throw new Error('Cannot infer I-frame initialization boundary');
          mapSequence = first.sequence;
          map = {
            url: first.url,
            range: { offset: 0, length: first.range.offset },
            key: first.key,
          };
        }
        if (map?.key?.method === 'AES-128' && original.map && !map.key.iv)
          throw new Error('Encrypted initialization needs an explicit IV');
        const segment: Segment = {
          ...original,
          map: map ? { ...map, key: undefined, keys: [] } : undefined,
          key: ['SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(
            original.key?.method ?? '',
          )
            ? original.key
            : undefined,
          keys: [],
        };
        const lane = new MediaLane(
          { ...playlist, segments: [segment] },
          'main',
          (r) => {
            const init = r === segment.map;
            return this.load(
              r,
              init ? map?.key : original.key,
              init ? mapSequence : original.sequence,
            );
          },
          async (data) => data,
          undefined,
          this.sampleDecrypt,
        );
        const prepared = await lane.prepare(0);
        const decoded = await decodePreview(prepared, this.client.signal);
        if (this.closed)
          throw new DOMException('Preview loader closed', 'AbortError');
        const thumbnail: Thumbnail = {
          url: URL.createObjectURL(decoded.blob),
          time: original.start,
          end: original.start + original.duration,
          x: 0,
          y: 0,
          width: decoded.width,
          height: decoded.height,
          sheetWidth: decoded.width,
          sheetHeight: decoded.height,
        };
        this.cache.set(key, thumbnail);
        while (this.cache.size > 12) {
          const first = this.cache.keys().next().value!;
          URL.revokeObjectURL(this.cache.get(first)!.url);
          this.cache.delete(first);
        }
        return thumbnail;
      })();
      this.pending.set(key, pending);
    }
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }
  destroy() {
    this.closed = true;
    for (const item of this.cache.values()) URL.revokeObjectURL(item.url);
    this.cache.clear();
  }
}
