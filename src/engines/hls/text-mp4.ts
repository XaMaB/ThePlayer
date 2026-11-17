import { boxes } from './mp4';
import { fragmentMetadata, fragmentSamples } from './fragment-samples';
import { parseTtml, type TtmlDocument } from './ttml';
import type { TextCue } from './subtitles';
export function textMetadata(init: Uint8Array) {
  const tracks = fragmentMetadata(init);
  if (tracks.length !== 1 || !['stpp', 'wvtt'].includes(tracks[0].format))
    throw new Error('Subtitle initialization requires one stpp or wvtt track');
  return tracks;
}
export function textSamples(
  data: Uint8Array,
  metadata: ReturnType<typeof textMetadata>,
  offset: number,
  resourceOffset = 0,
): { cues: TextCue[]; documents: TtmlDocument[] } {
  const cues: TextCue[] = [],
    documents: TtmlDocument[] = [];
  const decode = (data: Uint8Array) =>
    new TextDecoder('utf-8', { fatal: true }).decode(data);
  for (const sample of fragmentSamples(data, metadata, resourceOffset)) {
    if (sample.track.format === 'stpp') {
      documents.push(
        parseTtml(
          decode(sample.data),
          sample.time,
          sample.time + sample.duration,
          offset,
        ),
      );
    } else {
      for (const box of boxes(sample.data)) {
        if (box.type === 'vtte') continue;
        if (box.type !== 'vttc') throw new Error('Invalid WebVTT sample box');
        const children = boxes(box.body),
          payload = children.find((child) => child.type === 'payl');
        if (!payload) throw new Error('WebVTT cue lacks payl');
        const settings = children.find((child) => child.type === 'sttg');
        cues.push({
          start: sample.time + offset,
          end: sample.time + sample.duration + offset,
          text: decode(payload.body),
          settings: settings ? decode(settings.body) : '',
        });
      }
    }
  }
  return { cues, documents };
}
