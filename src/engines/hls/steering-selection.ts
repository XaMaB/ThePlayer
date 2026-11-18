import type { Variant, Rendition } from './playlist';
import { browserVariants, hasVideo } from './renditions';

/** Stable identity first, then preserve the bitrate ceiling when a pathway omits it. */
export function pathwayQuality(variants: Variant[], old: Variant): number {
  const same = variants.findIndex((v) =>
    old.stableId
      ? v.stableId === old.stableId
      : v.bandwidth === old.bandwidth &&
        v.resolution === old.resolution &&
        v.codecs === old.codecs,
  );
  if (same >= 0) return same;
  let below = -1;
  for (let i = 0; i < variants.length; i++)
    if (variants[i].bandwidth <= old.bandwidth) below = i;
  return below >= 0 ? below : 0;
}

export function pathwayLadder(
  variants: Variant[],
  old: Variant,
  mode: 'video' | 'audio',
  supported: (mime: string) => boolean,
) {
  const usable = browserVariants(variants, supported)
    .filter((v) => hasVideo(v) === (mode === 'video'))
    .sort((a, b) => a.bandwidth - b.bandwidth);
  if (!usable.length)
    throw new Error('Steering pathway has no supported media variants');
  const selected = usable[pathwayQuality(usable, old)];
  const levels = usable
    .filter(
      (v) => v.audio === selected.audio && v.subtitles === selected.subtitles,
    )
    .map((v, id) => ({
      ...v,
      id,
      label: v.resolution
        ? `${v.resolution.split('x')[1]}p · ${(v.bandwidth / 1e6).toFixed(2)} Mb/s`
        : `${(v.bandwidth / 1e6).toFixed(2)} Mb/s`,
    }));
  return { levels, index: levels.findIndex((v) => v.url === selected.url) };
}

export function matchingRendition<T extends Rendition>(
  tracks: T[],
  old?: {
    stableId?: string;
    language: string;
    label: string;
    forced?: boolean;
  },
) {
  if (!old) return;
  return (
    tracks.find((t) => old.stableId && t.stableId === old.stableId) ??
    tracks.find(
      (t) =>
        t.language === old.language &&
        t.name === old.label &&
        !!t.forced === !!old.forced,
    ) ??
    tracks.find(
      (t) => t.language === old.language && !!t.forced === !!old.forced,
    )
  );
}
