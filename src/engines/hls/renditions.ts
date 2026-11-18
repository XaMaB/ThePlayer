import { shiftPlaylist } from './playlist';
import { normalizeAv1Codec } from './av1';
import type { Playlist, Variant } from './playlist';

/** Older HLS masters spell AVC profile/level as decimal bytes (avc1.66.30).
 * Only playlist metadata is normalized; decoder configuration comes from SPS/avcC.
 */
export function normalizeCodec(value: string): string {
  const codec = value.trim().toLowerCase();
  if (['mp3', 'mp4a.6b', 'mp4a.69'].includes(codec)) return 'mp3';
  if (codec.startsWith('av01.')) return normalizeAv1Codec(codec) ?? codec;
  const legacy = /^avc1\.(\d{1,3})\.(\d{1,3})$/.exec(codec);
  if (!legacy) {
    if (/^(hvc1|hev1)\./.test(codec))
      return codec.slice(0, 5) + codec.slice(5).toUpperCase();
    return codec;
  }
  const profile = Number(legacy[1]),
    level = Number(legacy[2]);
  if (profile < 1 || profile > 255 || level < 1 || level > 255) return codec;
  return `avc1.${profile.toString(16).padStart(2, '0')}00${level.toString(16).padStart(2, '0')}`;
}
/** The demuxers currently support AVC, HEVC, AV1 (fMP4), AAC-LC and HE-AAC v1; filter declared unsupported codecs. */
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
          .every(
            (codec) =>
              /^(?:wvtt|stpp(?:\.ttml(?:\.(?:im1t|etd1)(?:\|(?:im1t|etd1))*)?)?)$/.test(
                codec,
              ) ||
              ['mp3', 'ac-3', 'ec-3'].includes(codec) ||
              !!normalizeAv1Codec(codec) ||
              /^(avc[13]\.[0-9a-f]{6}|(?:hvc1|hev1)\.[ABC]?\d+\.[0-9A-F]+\.[LH]\d+(?:\.[0-9A-F]{2})*|mp4a\.40\.[25])$/.test(
                codec,
              ),
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
    shift =
      anchor.start -
      (anchor.partOffset ?? 0) -
      overlap.start +
      (overlap.partOffset ?? 0);
  }
  return shiftPlaylist(next, shift);
}
export function segmentAt(p: Playlist, time: number): number {
  const index = p.segments.findIndex(
    (s) => s.start + s.duration > time + 0.005,
  );
  return index < 0 ? p.segments.length : index;
}
export class NoSwitchBoundary extends Error {
  constructor() {
    super('No future segment boundary available for switching');
  }
}
/** Switch at a future segment boundary, preserving the content currently being decoded. */
export function switchBoundary(p: Playlist, time: number): number {
  const segment = p.segments.find(
    (s) => s.start >= time + 0.15 && (s.part === undefined || s.independent),
  );
  if (!segment) throw new NoSwitchBoundary();
  return segment.start;
}

export function hasVideo(variant: Variant): boolean {
  return (
    !!variant.resolution ||
    /(?:^|,)\s*(?:avc[13]|hvc1|hev1|av01|vp0[89])\./i.test(variant.codecs ?? '')
  );
}
/** Capability checks precede ABR so unsupported profiles never enter the ladder. */
export function browserVariants(
  variants: Variant[],
  supports: (mime: string) => boolean,
): Variant[] {
  return compatibleVariants(variants)
    .map((v) => ({
      ...v,
      codecs: v.codecs
        ?.split(',')
        .filter((codec) => !/^(?:stpp(?:\.|$)|wvtt$)/.test(codec))
        .join(','),
    }))
    .filter(
      (v) =>
        !v.codecs ||
        (v.codecs === 'mp3' && supports('audio/mpeg')) ||
        supports(
          `${hasVideo(v) ? 'video' : 'audio'}/mp4; codecs="${v.codecs}"`,
        ),
    );
}
