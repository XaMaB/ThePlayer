import { HevcPictures } from './hevc-access';
import { AvcPictures, newPicture, type Picture } from './avc-access';
import { concat } from './mp4';
export interface VideoPes {
  data: Uint8Array;
  pts?: number;
  dts?: number;
}
interface Unit {
  data: Uint8Array;
  at: number;
}
interface Access {
  units: Uint8Array[];
  at: number;
  picture?: Picture;
  pts?: number;
  dts?: number;
}
export interface TimedAccess {
  units: Uint8Array[];
  pts: number;
  dts: number;
}
/** Annex-B boundaries may span PES packets; PES boundaries are not picture boundaries. */
function annexB(data: Uint8Array): Unit[] {
  const units: Unit[] = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (
      data[i] ||
      data[i + 1] ||
      !(data[i + 2] === 1 || (data[i + 2] === 0 && data[i + 3] === 1))
    )
      continue;
    if (start >= 0 && i > start)
      units.push({ data: data.subarray(start, i), at: start });
    start = i + (data[i + 2] === 1 ? 3 : 4);
    i = start - 1;
  }
  if (start >= 0 && start < data.length)
    units.push({ data: data.subarray(start), at: start });
  return units;
}
export function videoAccessUnits(
  packets: VideoPes[],
  hevc: boolean,
  avc: AvcPictures,
  h265: HevcPictures,
): TimedAccess[] {
  const anchors: { at: number; pts: number; dts: number }[] = [];
  let at = 0;
  for (const p of packets) {
    if (p.pts != null && p.dts != null)
      anchors.push({ at, pts: p.pts, dts: p.dts });
    at += p.data.length;
  }
  const groups: Access[] = [];
  let units: Uint8Array[] = [],
    firstVcl = -1,
    picture: Picture | undefined;
  const flush = () => {
    if (firstVcl >= 0) groups.push({ units, at: firstVcl, picture });
    units = [];
    firstVcl = -1;
    picture = undefined;
  };
  for (const nal of annexB(concat(...packets.map((p) => p.data)))) {
    const type = hevc ? (nal.data[0] >> 1) & 63 : nal.data[0] & 31;
    const vcl = hevc ? type < 32 : type === 1 || type === 5;
    const prefix = hevc
      ? [32, 33, 34, 35, 39].includes(type)
      : [6, 7, 8, 9, 14, 15, 16, 17, 18].includes(type);
    if (prefix && firstVcl >= 0) flush();
    if (hevc) h265.parameter(nal.data);
    else avc.parameter(nal.data);
    if (vcl) {
      const current = hevc
        ? nal.data[2] & 128
          ? h265.picture(nal.data)
          : picture
        : avc.picture(nal.data);
      if (
        firstVcl >= 0 &&
        (hevc ? !!(nal.data[2] & 128) : newPicture(picture!, current!))
      )
        flush();
      if (firstVcl < 0) {
        firstVcl = nal.at;
        picture = current;
      }
    }
    units.push(nal.data);
  }
  flush();
  let used = -1;
  for (const group of groups) {
    const index = anchors.findLastIndex((a) => a.at <= group.at);
    if (index >= 0 && index !== used) {
      group.pts = anchors[index].pts;
      group.dts = anchors[index].dts;
      used = index;
    }
  }
  if (groups.length && groups[0].dts == null)
    throw new Error('First video access unit needs a PES timestamp');
  let previousCadence: number | undefined;
  for (let i = 0; i < groups.length; ) {
    const anchor = groups[i];
    let end = i + 1;
    while (end < groups.length && groups[end].dts == null) end++;
    if (end > i + 1) {
      const nominal = anchor.picture?.frameDuration;
      const measured =
        end < groups.length
          ? (groups[end].dts! - anchor.dts!) / (end - i)
          : undefined;
      // Infer only constant-cadence pictures whose timing is bounded by PES anchors
      // or AVC VUI. Ambiguous variable-rate/field timing is rejected explicitly.
      const step = nominal ?? measured ?? previousCadence;
      if (
        !step ||
        step <= 0 ||
        step > 90000 ||
        (nominal && measured && Math.abs(nominal - measured) > 1)
      )
        throw new Error('Cannot infer video access-unit cadence from PES/VUI');
      previousCadence = step;
      for (let j = i + 1; j < end; j++) {
        const group = groups[j],
          p = group.picture,
          base = anchor.picture;
        if (p?.field || p?.idr)
          throw new Error(
            'Untimestamped field/IDR access unit needs an explicit PES anchor',
          );
        group.dts = anchor.dts! + (j - i) * step;
        if (
          p &&
          base &&
          p.pocType === 0 &&
          base.pocType === 0 &&
          p.pocBits === base.pocBits
        ) {
          if (p.order == null || base.order == null)
            throw new Error('Missing picture order for untimestamped picture');
          const delta = p.order - base.order;
          group.pts = anchor.pts! + (delta * step) / (hevc ? 1 : 2);
        } else {
          if (hevc || p?.b || base?.b)
            throw new Error(
              'Untimestamped reordered pictures need supported POC timing',
            );
          group.pts = anchor.pts! + (j - i) * step;
        }
      }
    }
    i = end;
  }
  return groups.map((g) => ({
    units: g.units,
    pts: Math.round(g.pts!),
    dts: Math.round(g.dts!),
  }));
}
