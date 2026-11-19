import {
  CaptionAppearanceController,
  type CaptionAppearance,
} from './caption-appearance';
import {
  chaptersFor,
  type Chapter,
  type PlaybackQueue,
} from './playback-queue';
import { NativeRemotePlayback, type CastSender } from './remote-playback';
import { downloadFrame, copyFrame } from './frame-capture';
export interface ControlExtrasOptions {
  playbackRates?: readonly number[] | false;
  captions?: CaptionAppearance | false;
  chapters?: readonly Chapter[] | ((player: any) => readonly Chapter[]);
  queue?: PlaybackQueue;
  remote?:
    | false
    | { video?: HTMLVideoElement; cast?: () => CastSender | undefined };
  frameCapture?: boolean;
}
/** Optional controls live in the existing options menu, not in a second overlay. */
export class ControlExtras {
  readonly captions?: CaptionAppearanceController;
  private remote?: NativeRemotePlayback;
  private root: HTMLElement;
  private speed: HTMLSelectElement;
  private captionPanel: HTMLDetailsElement;
  private chapterPanel: HTMLDetailsElement;
  private chapterList: HTMLElement;
  private queuePanel: HTMLDetailsElement;
  private queueList: HTMLElement;
  private capture: HTMLElement;
  private nativeButton: HTMLButtonElement;
  private castButton: HTMLButtonElement;
  private castPlay: HTMLButtonElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private chapterSignature = '';
  private queueSignature = '';
  private rates: readonly number[];
  private closed = false;
  private initialRate: number;
  private chosenRate?: number;
  private queueError = (event: Event) =>
    this.report((event as CustomEvent).detail.message);
  constructor(
    private screen: HTMLElement,
    private video: HTMLVideoElement,
    private getPlayer: () => any,
    private report: (error: string) => void,
    private config: ControlExtrasOptions = {},
  ) {
    this.rates =
      config.playbackRates === false
        ? []
        : (config.playbackRates ?? [0.5, 0.75, 1, 1.25, 1.5, 2]);
    if (
      this.rates.some(
        (rate) => !Number.isFinite(rate) || rate < 0.25 || rate > 4,
      )
    )
      throw new RangeError('Playback rates must be between 0.25 and 4');
    this.initialRate = video.playbackRate;
    const doc = screen.ownerDocument;
    this.root = doc.createElement('div');
    this.root.className = 'control-extras';
    screen.querySelector('#player-menu')!.append(this.root);
    const button = (text: string, parent = this.root) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.textContent = text;
      parent.append(b);
      return b;
    };
    const group = (title: string) => {
      const details = doc.createElement('details');
      const summary = doc.createElement('summary');
      summary.textContent = title;
      details.append(summary);
      this.root.append(details);
      return details;
    };
    const select = (
      title: string,
      entries: readonly [string, string][],
      parent: HTMLElement,
    ) => {
      const label = doc.createElement('label');
      label.textContent = title;
      const field = doc.createElement('select');
      field.setAttribute('aria-label', title);
      for (const [value, text] of entries) field.add(new Option(text, value));
      label.append(field);
      parent.append(label);
      return field;
    };
    this.speed = select(
      'Playback speed',
      this.rates.map((rate) => [
        String(rate),
        rate === 1 ? 'Normal · 1×' : `${rate}×`,
      ]),
      this.root,
    );
    this.speed.onchange = () => {
      try {
        if (
          getPlayer()?.isLive ||
          getPlayer()?.diagnostics?.interstitial?.active
        )
          return;
        const rate = Number(this.speed.value);
        video.playbackRate = rate;
        this.chosenRate = rate;
      } catch (error) {
        report((error as Error).message);
      }
    };
    this.captionPanel = group('Subtitle appearance');
    if (config.captions !== false) {
      this.captions = new CaptionAppearanceController(video, config.captions);
      const fields: Record<string, HTMLSelectElement> = {};
      fields.scale = select(
        'Size',
        [
          ['1', 'Source · 100%'],
          ['0.75', '75%'],
          ['1.25', '125%'],
          ['1.5', '150%'],
          ['2', '200%'],
        ],
        this.captionPanel,
      );
      fields.offset = select(
        'Vertical position',
        [
          ['0', 'Source position'],
          ['-10', 'Up 10%'],
          ['-20', 'Up 20%'],
          ['10', 'Down 10%'],
        ],
        this.captionPanel,
      );
      fields.color = select(
        'Text color',
        [
          ['source', 'Source'],
          ['white', 'White'],
          ['yellow', 'Yellow'],
          ['cyan', 'Cyan'],
        ],
        this.captionPanel,
      );
      fields.background = select(
        'Text background',
        [
          ['source', 'Source'],
          ['transparent', 'Transparent'],
          ['dark', 'Dark · 75%'],
          ['solid', 'Black'],
        ],
        this.captionPanel,
      );
      fields.font = select(
        'Font',
        [
          ['source', 'Source'],
          ['sans-serif', 'Sans serif'],
          ['serif', 'Serif'],
          ['monospace', 'Monospace'],
        ],
        this.captionPanel,
      );
      fields.outline = select(
        'Text outline',
        [
          ['false', 'Source'],
          ['true', 'Dark outline'],
        ],
        this.captionPanel,
      );
      const sync = () => {
        for (const [key, field] of Object.entries(fields)) {
          const value =
            this.captions!.value[key as keyof CaptionAppearance] ??
            { scale: 1, offset: 0, outline: false }[key] ??
            'source';
          if (!Array.from(field.options).some((o) => o.value === String(value)))
            field.add(new Option(String(value), String(value)));
          field.value = String(value);
        }
      };
      for (const [key, field] of Object.entries(fields))
        field.onchange = () => {
          try {
            this.captions!.set({
              ...this.captions!.value,
              [key]: ['scale', 'offset'].includes(key)
                ? Number(field.value)
                : key === 'outline'
                  ? field.value === 'true'
                  : field.value,
            });
          } catch (error) {
            report((error as Error).message);
          }
        };
      const note = doc.createElement('small');
      note.textContent =
        'Bitmap captions support size and position only. Source layout is preserved until you change it.';
      this.captionPanel.append(note);
      button('Reset subtitle appearance', this.captionPanel).onclick = () => {
        this.captions!.reset();
        sync();
      };
      sync();
    }
    this.chapterPanel = group('Chapters');
    this.chapterList = doc.createElement('div');
    this.chapterPanel.append(this.chapterList);
    this.queuePanel = group('Playback queue');
    this.queueList = doc.createElement('div');
    this.queuePanel.append(this.queueList);
    this.previous = button('Previous', this.queuePanel);
    this.next = button('Next', this.queuePanel);
    this.previous.onclick = () => this.run(() => config.queue!.previous());
    this.next.onclick = () => this.run(() => config.queue!.next());
    config.queue?.addEventListener('error', this.queueError);
    this.nativeButton = button('AirPlay / Remote playback');
    if (config.remote !== false)
      this.remote = new NativeRemotePlayback(config.remote?.video ?? video);
    this.nativeButton.onclick = () => this.run(() => this.remote!.prompt());
    this.castButton = button('Google Cast');
    this.castButton.onclick = () => {
      const cast = this.cast;
      if (!cast) return;
      if (cast.connected) cast.disconnect();
      else this.run(() => cast.connect());
    };
    this.castPlay = button('Pause on TV');
    this.castPlay.onclick = () => this.cast?.togglePlay();
    this.capture = group('Capture frame');
    button('Save frame as PNG', this.capture).onclick = () =>
      this.run(() => downloadFrame(video));
    const copy = button('Copy frame', this.capture);
    copy.hidden = !navigator.clipboard?.write || !('ClipboardItem' in window);
    copy.onclick = () => this.run(() => copyFrame(video));
    this.root.hidden = true;
  }
  private get cast() {
    return this.config.remote === false
      ? undefined
      : this.config.remote?.cast?.();
  }
  private run(action: () => Promise<unknown>) {
    void action().catch((error) => {
      if (!this.closed) this.report(error?.message ?? String(error));
    });
  }
  refresh() {
    if (this.closed) return;
    this.root.hidden = false;
    const player = this.getPlayer(),
      inserted = !!player?.diagnostics?.interstitial?.active;
    this.speed.parentElement!.hidden =
      !this.rates.length || !player || player.isLive || inserted;
    if (
      Array.from(this.speed.options).some(
        (option) => Number(option.value) === this.video.playbackRate,
      )
    )
      this.speed.value = String(this.video.playbackRate);
    // Do not carry a user-selected VOD rate into live latency control.
    if (player?.isLive && this.chosenRate !== undefined) {
      if (this.video.playbackRate === this.chosenRate)
        this.video.playbackRate = 1;
      this.chosenRate = undefined;
    }
    this.captionPanel.hidden =
      !this.captions || !player?.subtitleTracks?.length;
    const selected = player?.subtitleTracks?.find(
      (track: any) => track.name === player.selectedSubtitleTrack,
    );
    const bitmap = ['dvb', 'teletext'].includes(selected?.format);
    for (const field of this.captionPanel.querySelectorAll<HTMLSelectElement>(
      'select',
    ))
      field.disabled =
        bitmap &&
        !['Size', 'Vertical position'].includes(
          field.getAttribute('aria-label') ?? '',
        );
    const queue = this.config.queue;
    const supplied =
      typeof this.config.chapters === 'function'
        ? this.config.chapters(player)
        : (this.config.chapters ??
          (queue && queue.index >= 0
            ? queue.items[queue.index].chapters
            : undefined));
    const chapters = chaptersFor(this.video, supplied);
    this.chapterPanel.hidden = !chapters.length || inserted;
    const signature = JSON.stringify(chapters);
    if (signature !== this.chapterSignature) {
      this.chapterSignature = signature;
      this.chapterList.replaceChildren();
      for (const chapter of chapters) {
        const b = this.screen.ownerDocument.createElement('button');
        b.type = 'button';
        b.textContent = `${Math.floor(chapter.start / 60)}:${String(Math.floor(chapter.start % 60)).padStart(2, '0')} · ${chapter.title}`;
        b.onclick = () => {
          const ranges = this.video.seekable;
          if (inserted) return;
          if (
            ranges.length &&
            !Array.from(
              { length: ranges.length },
              (_, i) =>
                chapter.start >= ranges.start(i) &&
                chapter.start <= ranges.end(i),
            ).some(Boolean)
          ) {
            this.report('This chapter is outside the available seek window');
            return;
          }
          this.video.currentTime = chapter.start;
        };
        this.chapterList.append(b);
      }
    }
    this.queuePanel.hidden = !queue?.items.length || inserted;
    if (queue) {
      const signature = JSON.stringify([queue.index, queue.loading]);
      if (signature !== this.queueSignature) {
        this.queueSignature = signature;
        this.queueList.replaceChildren();
        queue.items.forEach((item, index) => {
          const b = this.screen.ownerDocument.createElement('button');
          b.type = 'button';
          b.textContent = (index === queue.index ? '✓ ' : '') + item.title;
          b.disabled = queue.loading;
          b.onclick = () => this.run(() => queue.select(index));
          this.queueList.append(b);
        });
      }
      this.previous.disabled = queue.loading || !queue.hasPrevious;
      this.next.disabled = queue.loading || !queue.hasNext;
    }
    this.nativeButton.hidden = !this.remote?.supported;
    this.nativeButton.textContent = this.remote?.connected
      ? 'Remote playback · connected'
      : 'AirPlay / Remote playback';
    const cast = this.cast;
    this.castButton.hidden = !cast?.supported && !cast?.connected;
    this.castButton.textContent = cast?.connected
      ? 'Disconnect Google Cast'
      : 'Google Cast';
    this.castPlay.hidden = !cast?.connected;
    this.castPlay.textContent = cast?.paused ? 'Play on TV' : 'Pause on TV';
    this.capture.hidden =
      !this.config.frameCapture ||
      !!this.video.mediaKeys ||
      !!player?.source?.drm ||
      !this.video.videoWidth ||
      this.video.readyState < 2 ||
      inserted;
  }
  destroy() {
    this.closed = true;
    this.config.queue?.removeEventListener('error', this.queueError);
    this.captions?.destroy();
    this.remote?.destroy();
    this.root.remove();
    if (
      this.chosenRate !== undefined &&
      this.video.playbackRate === this.chosenRate
    )
      this.video.playbackRate = this.initialRate;
  }
}
