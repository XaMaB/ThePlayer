import { delay, type NetworkOptions } from '../hls/network';
import { DashResourceClient } from './network';
import {
  parseVtt,
  nativeCue,
  vttHeaders,
  WebVttStyles,
} from '../hls/subtitles';
import { textMetadata, textSamples } from '../hls/text-mp4';
import { parseTtml } from '../hls/ttml';
import { TtmlRenderer } from '../hls/ttml-renderer';
import { initializationResource, segmentReferences } from './segments';
import { parseSidx } from './sidx';
import type {
  Adaptation,
  Period,
  Representation,
  SegmentReference,
} from './model';
export function textFormat(rep: Representation) {
  if (rep.mimeType === 'text/vtt' || rep.codecs === 'wvtt') return 'webvtt';
  if (rep.mimeType === 'application/ttml+xml' || rep.codecs.startsWith('stpp'))
    return 'ttml';
  return undefined;
}
const nativeTracks = new WeakMap<HTMLVideoElement, TextTrack>();
/** Independent text loader: subtitle delivery cannot block the A/V scheduler. */
export class DashSubtitles {
  private abort = new AbortController();
  private client: DashResourceClient;
  private track?: TextTrack;
  private renderer?: TtmlRenderer;
  private styles?: WebVttStyles;
  private runner: Promise<void>;
  private generation = 0;
  private periodId = '';
  private seen = new Map<string, number>();
  private metadata?: ReturnType<typeof textMetadata>;
  private index?: SegmentReference[];
  private initialized = false;
  private received = 0;
  private displayed = 0;
  private previous = '';
  constructor(
    private video: HTMLVideoElement,
    private selected: Adaptation,
    private period: () => Period,
    network: NetworkOptions | undefined,
    private emit: (name: string, data: unknown) => void,
  ) {
    this.client = new DashResourceClient(network ?? {}, this.abort.signal);
    video.addEventListener(
      'seeking',
      () => {
        this.generation++;
        this.clear(true);
      },
      { signal: this.abort.signal },
    );
    this.runner = this.run().catch((error) => {
      if (!this.abort.signal.aborted) {
        this.clear();
        this.emit(
          'captionwarning',
          new Error('DASH subtitle loading failed', { cause: error }),
        );
      }
    });
  }
  private present(text: string) {
    if (text && text !== this.previous) this.displayed++;
    this.previous = text;
    this.emit('subtitlemetrics', {
      received: this.received,
      displayed: this.displayed,
    });
  }
  private clear(preserveNative = false) {
    this.seen.clear();
    if (this.track && !preserveNative)
      for (const cue of Array.from(this.track.cues ?? []))
        this.track.removeCue(cue);
    this.renderer?.destroy();
    this.renderer = undefined;
    this.styles?.destroy();
    this.styles = undefined;
    this.previous = '';
  }
  private async run() {
    while (!this.abort.signal.aborted) {
      const period = this.period();
      if (this.periodId !== period.id) {
        this.clear(true);
        this.metadata = undefined;
        this.index = undefined;
        this.initialized = false;
        this.periodId = period.id;
      }
      const adaptation =
        period.adaptations.find(
          (a) => a.id === this.selected.id && a.kind === 'text',
        ) ??
        period.adaptations.find(
          (a) => a.kind === 'text' && a.language === this.selected.language,
        );
      if (!adaptation) {
        await delay(250, this.abort.signal);
        continue;
      }
      const rep = adaptation.representations.find((r) => !!textFormat(r));
      if (!rep) throw new Error('Unsupported DASH subtitle representation');
      if (rep.protection.length)
        throw new Error('Encrypted DASH subtitles are not implemented');
      const generation = this.generation;
      if (!this.initialized) {
        if (rep.mimeType === 'application/mp4') {
          const init = await this.client.get(initializationResource(rep));
          this.metadata = textMetadata(init.data);
        }
        if (rep.address.kind === 'base') {
          if (!rep.address.indexRange)
            throw new Error('DASH subtitle indexRange is required');
          const data = await this.client.get({
            url: rep.baseUrls[0],
            alternatives: rep.baseUrls.slice(1),
            range: rep.address.indexRange,
          });
          this.index = parseSidx(
            data.data,
            rep.address.indexRange.offset,
            data.url,
            rep,
            period,
          ).map((reference) => ({
            ...reference,
            alternatives: rep.baseUrls.filter((url) => url !== data.url),
          }));
        }
        this.initialized = true;
      }
      const time = Math.max(period.start, this.video.currentTime);
      const references =
        this.index ??
        segmentReferences(
          rep,
          period,
          Math.max(period.start, time - 2),
          time + 15,
        );
      const segment = references.find(
        (s) =>
          s.end > time - 2 &&
          s.start < time + 15 &&
          !this.seen.has(`${s.number}:${s.time}`),
      );
      if (!segment) {
        await delay(250, this.abort.signal);
        continue;
      }
      const data = await this.client.get(segment);
      if (generation !== this.generation || period.id !== this.period().id)
        continue;
      if (data.data.length > 4 * 1024 * 1024)
        throw new Error('DASH subtitle segment exceeds limit');
      const offset =
        period.start -
        Number(rep.address.presentationTimeOffset) / rep.address.timescale;
      let cues: ReturnType<typeof parseVtt> = [];
      let documents: ReturnType<typeof parseTtml>[] = [];
      let regions = new Map();
      if (this.metadata) {
        ({ cues, documents } = textSamples(
          data.data,
          this.metadata,
          offset,
          segment.range?.offset ?? 0,
        ));
      } else {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(
          data.data,
        );
        if (textFormat(rep) === 'webvtt') {
          cues = parseVtt(text, offset);
          const headers = vttHeaders(text);
          regions = headers.regions;
          if (headers.styles.length) {
            this.styles ??= new WebVttStyles(this.video);
            for (const style of headers.styles) this.styles.add(style);
          }
        } else
          documents = [
            parseTtml(
              text,
              segment.start - offset,
              segment.end - offset,
              offset,
            ),
          ];
      }
      if (cues.length) {
        if (!this.track) {
          this.track = nativeTracks.get(this.video);
          if (!this.track) {
            this.track = this.video.addTextTrack('subtitles', 'DASH subtitles');
            nativeTracks.set(this.video, this.track);
          }
          this.track.addEventListener(
            'cuechange',
            () =>
              this.present(
                Array.from(this.track?.activeCues ?? [])
                  .map((c) => (c as VTTCue).text)
                  .join('\n'),
              ),
            { signal: this.abort.signal },
          );
        }
        this.track.mode = 'showing';
        const existing = new Set(
          Array.from(this.track.cues ?? []).map((c) =>
            JSON.stringify([c.startTime, c.endTime, (c as VTTCue).text]),
          ),
        );
        for (const cue of cues) {
          cue.start = Math.max(period.start, cue.start);
          cue.end = Math.min(
            period.start + (period.duration ?? Infinity),
            cue.end,
          );
          const key = JSON.stringify([cue.start, cue.end, cue.text]);
          if (cue.end > cue.start && !existing.has(key)) {
            existing.add(key);
            this.track.addCue(nativeCue(cue, regions));
            this.received++;
          }
        }
        for (const cue of Array.from(this.track.cues ?? []))
          if (cue.endTime < time - 30) this.track.removeCue(cue);
        if ((this.track.cues?.length ?? 0) > 5000)
          throw new Error('DASH subtitle cue limit');
      }
      if (documents.length) {
        this.renderer ??= new TtmlRenderer(this.video, (text) =>
          this.present(text),
        );
        for (const doc of documents) {
          this.renderer.add(doc);
          this.received += doc.paragraphs.length;
        }
      }
      this.seen.set(`${segment.number}:${segment.time}`, segment.end);
      for (const [key, end] of this.seen)
        if (end < time - 30) this.seen.delete(key);
      this.emit('subtitlemetrics', {
        received: this.received,
        displayed: this.displayed,
      });
    }
  }
  async destroy() {
    this.abort.abort();
    await this.runner;
    this.clear();
    if (this.track) this.track.mode = 'disabled';
  }
}
