import type { Thumbnail } from '../../core/thumbnail';
import { jpegSize } from '../hls/thumbnails';
import type {
  Manifest,
  Period,
  Representation,
  SegmentReference,
} from './model';
import type { DashResourceClient } from './network';
import { segmentReferences } from './segments';
export function thumbnailTile(
  rep: Representation,
  period: Period,
  ref: SegmentReference,
  time: number,
) {
  const { columns, rows } = rep.tiles ?? { columns: 1, rows: 1 };
  if (!rep.width || !rep.height || rep.width % columns || rep.height % rows)
    throw new Error('DASH thumbnail dimensions do not match grid');
  // Preserve the full sheet duration even when the final sheet extends beyond the Period.
  const duration = ref.end - ref.start;
  const interval = duration / (columns * rows);
  const tile = Math.floor((time - ref.start) / interval);
  if (
    tile < 0 ||
    tile >= columns * rows ||
    time >= period.start + (period.duration ?? Infinity)
  )
    return;
  return {
    x: (tile % columns) * (rep.width / columns),
    y: Math.floor(tile / columns) * (rep.height / rows),
    width: rep.width / columns,
    height: rep.height / rows,
    time: ref.start + tile * interval,
    end: Math.min(
      ref.start + (tile + 1) * interval,
      period.start + (period.duration ?? Infinity),
    ),
  };
}
export class DashThumbnails {
  private cache = new Map<string, { url: string; bytes: number }>();
  private pending = new Map<string, Promise<{ url: string; bytes: number }>>();
  private closed = false;
  constructor(
    private client: DashResourceClient,
    private manifest: () => Manifest,
  ) {}
  async get(time: number): Promise<Thumbnail | undefined> {
    if (!Number.isFinite(time) || time < 0)
      throw new Error('Invalid thumbnail time');
    if (this.closed) return;
    const period = this.manifest().periods.findLast((p) => p.start <= time);
    if (!period) return;
    const rep = period.adaptations
      .filter((a) => a.kind === 'image')
      .flatMap((a) => a.representations)
      .filter(
        (r) =>
          r.mimeType === 'image/jpeg' &&
          r.address.kind !== 'base' &&
          !r.protection.length,
      )
      .sort((a, b) => a.bandwidth - b.bandwidth)[0];
    if (!rep) return;
    const reference = segmentReferences(
      rep,
      { ...period, duration: undefined },
      time,
      time + 0.001,
    ).find((r) => r.start <= time && r.end > time);
    if (!reference) return;
    const tile = thumbnailTile(rep, period, reference, time);
    if (!tile) return;
    const key = JSON.stringify([reference.url, reference.range]);
    let sheet = this.cache.get(key);
    if (!sheet) {
      let pending = this.pending.get(key);
      if (!pending) {
        if (this.pending.size >= 4) return;
        pending = (async () => {
          const { data } = await this.client.get(reference, {
            retries: 0,
            recoveryWindowMs: 0,
            timeoutMs: 5000,
          });
          if (data.length > 16 * 1024 * 1024)
            throw new Error('DASH thumbnail byte limit');
          const size = jpegSize(data);
          if (size.width !== rep.width || size.height !== rep.height)
            throw new Error('DASH thumbnail differs from declared dimensions');
          if (this.closed)
            throw new DOMException('Thumbnail loader closed', 'AbortError');
          const item = {
            url: URL.createObjectURL(
              new Blob([data as BlobPart], { type: 'image/jpeg' }),
            ),
            bytes: data.length,
          };
          this.cache.set(key, item);
          while (
            this.cache.size > 8 ||
            [...this.cache.values()].reduce((n, v) => n + v.bytes, 0) >
              32 * 1024 * 1024
          ) {
            const oldest = this.cache.keys().next().value!;
            URL.revokeObjectURL(this.cache.get(oldest)!.url);
            this.cache.delete(oldest);
          }
          return item;
        })();
        this.pending.set(key, pending);
      }
      try {
        sheet = await pending;
      } finally {
        if (this.pending.get(key) === pending) this.pending.delete(key);
      }
    }
    return {
      ...tile,
      url: sheet.url,
      sheetWidth: rep.width!,
      sheetHeight: rep.height!,
    };
  }
  destroy() {
    this.closed = true;
    for (const item of this.cache.values()) URL.revokeObjectURL(item.url);
    this.cache.clear();
  }
}
