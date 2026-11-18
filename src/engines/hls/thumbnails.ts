import {
  parsePlaylist,
  type Playlist,
  type Segment,
  type Variant,
} from './playlist';
import { alignRendition } from './renditions';
import type { ResourceClient } from './network';

import type { Thumbnail } from '../../core/thumbnail';

/** Read JPEG dimensions before handing potentially large images to the browser. */
export function jpegSize(data: Uint8Array) {
  if (data[0] !== 0xff || data[1] !== 0xd8)
    throw new Error('Image is not JPEG');
  for (let at = 2; at < data.length; ) {
    if (data[at++] !== 0xff) throw new Error('Invalid JPEG marker');
    while (data[at] === 0xff) at++;
    const marker = data[at++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > data.length) break;
    const length = data[at] * 256 + data[at + 1];
    if (length < 2 || at + length > data.length)
      throw new Error('Truncated JPEG');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new Error('Truncated JPEG frame');
      const height = data[at + 3] * 256 + data[at + 4],
        width = data[at + 5] * 256 + data[at + 6];
      if (!width || !height || width * height > 16777216)
        throw new Error('JPEG exceeds pixel limit');
      return { width, height };
    }
    at += length;
  }
  throw new Error('Unsupported or missing JPEG frame header');
}
export function imageTile(
  segment: Segment,
  time: number,
  width: number,
  height: number,
) {
  if (
    time < segment.start ||
    time >= segment.start + segment.duration ||
    segment.gap
  )
    return;
  const tiles = segment.tiles;
  if (!tiles)
    return {
      x: 0,
      y: 0,
      width,
      height,
      time: segment.start,
      end: segment.start + segment.duration,
    };
  if (
    width !== tiles.width * tiles.columns ||
    height !== tiles.height * tiles.rows
  )
    throw new Error('JPEG size does not match tile grid');
  const index = Math.min(
    tiles.columns * tiles.rows - 1,
    Math.floor((time - segment.start) / tiles.duration),
  );
  const start = segment.start + index * tiles.duration;
  const end =
    index === tiles.columns * tiles.rows - 1
      ? segment.start + segment.duration
      : Math.min(segment.start + segment.duration, start + tiles.duration);
  return {
    x: (index % tiles.columns) * tiles.width,
    y: Math.floor(index / tiles.columns) * tiles.height,
    width: tiles.width,
    height: tiles.height,
    time: start,
    end,
  };
}
export class ImageThumbnails {
  private playlist?: Playlist;
  private refreshedAt = 0;
  private loading?: Promise<Playlist>;
  private cache = new Map<
    string,
    { url: string; width: number; height: number; bytes: number }
  >();
  private pending = new Map<
    string,
    Promise<{ url: string; width: number; height: number; bytes: number }>
  >();
  private closed = false;
  constructor(
    private variant: Variant,
    private client: ResourceClient,
    private reference: () => Playlist,
    private decrypt: (
      data: Uint8Array,
      segment: Segment,
    ) => Promise<Uint8Array>,
    private variables: () => Record<string, string> = () => ({}),
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
        throw new Error('Image playlist exceeds limit');
      const p = parsePlaylist(
        new TextDecoder('utf-8', { fatal: true }).decode(response.data),
        response.url,
        this.variables(),
      );
      if (!p.imagesOnly || p.variants.length || p.unsupported.length)
        throw new Error('Invalid image media playlist');
      if (
        p.live &&
        (!p.segments.some((s) => s.programDateTime) ||
          !this.reference().segments.some((s) => s.programDateTime))
      )
        throw new Error('Live image playlists require PROGRAM-DATE-TIME');
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
  async get(time: number): Promise<Thumbnail | undefined> {
    if (!Number.isFinite(time) || time < 0)
      throw new Error('Invalid thumbnail time');
    if (this.closed) return;
    const playlist = await this.read();
    const segment = playlist.segments.find(
      (s) => time >= s.start && time < s.start + s.duration,
    );
    if (!segment || segment.gap) return;
    const key = JSON.stringify([segment.url, segment.range, segment.key]);
    let sheet = this.cache.get(key);
    if (!sheet) {
      let job = this.pending.get(key);
      if (!job) {
        if (this.pending.size >= 4) return;
        job = (async () => {
          let data = (
            await this.client.get(segment, {
              recoveryWindowMs: 0,
              retries: 0,
              timeoutMs: 5000,
            })
          ).data;
          if (data.length > 16 * 1024 * 1024)
            throw new Error('JPEG resource exceeds limit');
          data = await this.decrypt(data, segment);
          const size = jpegSize(data);
          const [maxWidth, maxHeight] = this.variant
            .resolution!.split('x')
            .map(Number);
          const tile = segment.tiles;
          if (
            (tile?.width ?? size.width) > maxWidth ||
            (tile?.height ?? size.height) > maxHeight
          )
            throw new Error('Image exceeds advertised target resolution');
          imageTile(segment, time, size.width, size.height);
          if (this.closed)
            throw new DOMException('Thumbnail loader closed', 'AbortError');
          const item = {
            url: URL.createObjectURL(
              new Blob([data as BlobPart], { type: 'image/jpeg' }),
            ),
            ...size,
            bytes: data.length,
          };
          this.cache.set(key, item);
          while (
            this.cache.size > 8 ||
            [...this.cache.values()].reduce((n, v) => n + v.bytes, 0) >
              32 * 1024 * 1024
          ) {
            const first = this.cache.keys().next().value!;
            URL.revokeObjectURL(this.cache.get(first)!.url);
            this.cache.delete(first);
          }
          return item;
        })();
        this.pending.set(key, job);
      }
      try {
        sheet = await job;
      } finally {
        if (this.pending.get(key) === job) this.pending.delete(key);
      }
    } else {
      this.cache.delete(key);
      this.cache.set(key, sheet);
    }
    const tile = imageTile(segment, time, sheet.width, sheet.height);
    return tile
      ? {
          url: sheet.url,
          ...tile,
          sheetWidth: sheet.width,
          sheetHeight: sheet.height,
        }
      : undefined;
  }
  destroy() {
    this.closed = true;
    for (const item of this.cache.values()) URL.revokeObjectURL(item.url);
    this.cache.clear();
  }
}
