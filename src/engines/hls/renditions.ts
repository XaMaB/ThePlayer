import type { Playlist, Variant } from './playlist';

/** Older HLS masters spell AVC profile/level as decimal bytes (avc1.66.30).
 * Only playlist metadata is normalized; decoder configuration comes from SPS/avcC.
 */
export function normalizeCodec(value: string): string {
  const codec = value.trim().toLowerCase();
  const legacy = /^avc1\.(\d{1,3})\.(\d{1,3})$/.exec(codec);
  if (!legacy) return codec;
  const profile = Number(legacy[1]),
    level = Number(legacy[2]);
  if (profile < 1 || profile > 255 || level < 1 || level > 255) return codec;
  return `avc1.${profile.toString(16).padStart(2, '0')}00${level.toString(16).padStart(2, '0')}`;
}
/** The demuxers currently support AVC, AAC-LC and HE-AAC v1; filter declared unsupported codecs. */
export function compatibleVariants(variants: Variant[]): Variant[] {
  return variants
    .map((v) => ({
      ...v,
      codecs: v.codecs?.split(',').map(normalizeCodec).join(','),
    }))
    .filter(
      (v) =>
        !v.codecs ||
        v.codecs
          .split(',')
          .every((codec) =>
            /^(avc[13]\.[0-9a-f]{6}|mp4a\.40\.[25])$/.test(codec),
          ),
    );
}
/** Align rendition playlists using presentation time, never assuming matching array indices. */
export function alignRendition(next: Playlist, reference: Playlist): Playlist {
  if (next.live !== reference.live)
    throw new Error('Renditions disagree on live/VOD state');
  if (!next.live) return next;
  const a = next.segments.find((s) => s.programDateTime),
    b = reference.segments.find((s) => s.programDateTime);
  let shift: number;
  if (a && b) {
    shift =
      b.start +
      (Date.parse(a.programDateTime!) - Date.parse(b.programDateTime!)) / 1000 -
      a.start;
    if (!Number.isFinite(shift))
      throw new Error('Invalid rendition PROGRAM-DATE-TIME');
  } else {
    const overlap = next.segments.find((s) =>
      reference.segments.some(
        (r) => s.sequence === r.sequence && s.discontinuity === r.discontinuity,
      ),
    );
    if (!overlap)
      throw new Error(
        'Live renditions need overlapping sequence numbers or PROGRAM-DATE-TIME',
      );
    const anchor = reference.segments.find(
      (s) =>
        s.sequence === overlap.sequence &&
        s.discontinuity === overlap.discontinuity,
    )!;
    shift = anchor.start - overlap.start;
  }
  return {
    ...next,
    segments: next.segments.map((s) => ({ ...s, start: s.start + shift })),
  };
}
export function segmentAt(p: Playlist, time: number): number {
  const index = p.segments.findIndex(
    (s) => s.start + s.duration > time + 0.005,
  );
  return index < 0 ? p.segments.length : index;
}
/** Switch at a future segment boundary, preserving the content currently being decoded. */
export function switchBoundary(p: Playlist, time: number): number {
  const segment = p.segments.find((s) => s.start >= time + 0.15);
  if (!segment)
    throw new Error('No future segment boundary available for switching');
  return segment.start;
}
