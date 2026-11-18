import type { Playlist, Variant } from './playlist';
import { selectRendition } from './selection';

/** A missing VIDEO URI denotes video carried by the variant's own media playlist. */
export function videoRenditions(
  master: Playlist | undefined,
  variant: Variant,
  preferred?: string,
) {
  const tracks = (master?.renditions ?? [])
    .filter((r) => r.type === 'VIDEO' && r.group === variant.video)
    .map((r) => ({
      ...r,
      label: r.name,
      name: 'hls-video-' + encodeURIComponent(r.name),
      url: r.url ?? variant.url,
    }));
  const selected =
    tracks.find((r) => r.label === preferred) ??
    selectRendition(tracks, 'audio');
  if (tracks.length && !selected)
    throw new Error('No automatic video rendition; specify videoRendition');
  return { tracks, selected, url: selected?.url ?? variant.url };
}
