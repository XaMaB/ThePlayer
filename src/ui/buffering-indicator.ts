export interface BufferingIndicatorOptions {
  /** Milliseconds before showing the indicator. Default: 300. */
  delayMs?: number;
  /** Milliseconds from the start of waiting before showing the label. Default: 2500. */
  labelDelayMs?: number;
  position?: 'bottom' | 'top' | 'center';
  color?: string;
  accentColor?: string;
  label?: string;
}

/** Presentation only: never changes playback, buffering policy or network requests. */
export class BufferingIndicator {
  private readonly element: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly abort = new AbortController();
  private showTimer?: ReturnType<typeof setTimeout>;
  private labelTimer?: ReturnType<typeof setTimeout>;
  private waiting = false;
  private engineWaiting = false;
  private closed = false;
  private readonly delay: number;
  private readonly labelDelay: number;

  constructor(
    screen: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly options: BufferingIndicatorOptions = {},
  ) {
    this.delay = options.delayMs ?? 300;
    this.labelDelay = options.labelDelayMs ?? 2500;
    for (const value of [this.delay, this.labelDelay])
      if (!Number.isFinite(value) || value < 0 || value > 2147483647)
        throw new RangeError(
          'Buffering delays must be between 0 and 2147483647 milliseconds',
        );
    if (!['bottom', 'top', 'center'].includes(options.position ?? 'bottom'))
      throw new RangeError('Unknown buffering indicator position');
    const doc = screen.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'theplayer-buffering';
    this.element.dataset.position = options.position ?? 'bottom';
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
    this.element.setAttribute('aria-hidden', 'true');
    if (options.color)
      this.element.style.setProperty('--buffering-color', options.color);
    if (options.accentColor)
      this.element.style.setProperty('--buffering-accent', options.accentColor);
    const marks = doc.createElement('span');
    marks.className = 'buffering-marks';
    marks.setAttribute('aria-hidden', 'true');
    marks.innerHTML =
      '<svg viewBox="0 0 64 28"><path d="m7 5 9 9-9 9"/><path d="m25 5 9 9-9 9"/><path d="m43 5 9 9-9 9"/></svg>';
    this.label = doc.createElement('span');
    this.label.className = 'buffering-label';
    this.element.append(marks, this.label);
    screen.append(this.element);
    const listen = (event: string, handler: () => void) =>
      video.addEventListener(event, handler, { signal: this.abort.signal });
    for (const event of ['waiting', 'stalled', 'play', 'seeking'])
      listen(event, () => {
        if (video.readyState < 3) this.begin();
      });
    for (const event of ['playing', 'canplay', 'timeupdate', 'seeked'])
      listen(event, () => {
        if (!this.engineWaiting && video.readyState >= 3) this.reset();
      });
    listen('pause', () => {
      // MoQ deliberately pauses while rebuilding its buffer; statechange ends it.
      if (!this.engineWaiting) this.reset();
    });
    for (const event of ['ended', 'error', 'emptied', 'loadstart', 'abort'])
      listen(event, () => this.reset());
    if (!video.paused && video.readyState < 3) this.begin();
  }

  /** MoQ may intentionally pause the media element while its buffer recovers. */
  setEngineState(state: string, protocol: string) {
    if (state === 'buffering' && protocol === 'moq') {
      this.engineWaiting = true;
      this.begin();
    } else if (
      ['playing', 'paused', 'error', 'closed', 'destroyed'].includes(state)
    ) {
      this.reset();
    }
  }

  private pending() {
    return (
      !this.closed &&
      !this.video.ended &&
      !this.video.error &&
      (this.engineWaiting || (!this.video.paused && this.video.readyState < 3))
    );
  }

  private begin() {
    if (this.waiting || !this.pending()) return;
    this.waiting = true;
    this.showTimer = setTimeout(() => {
      if (!this.pending()) {
        this.reset();
        return;
      }
      this.element.classList.add('is-visible');
      this.element.setAttribute('aria-hidden', 'false');
    }, this.delay);
    this.labelTimer = setTimeout(
      () => {
        if (!this.pending()) {
          this.reset();
          return;
        }
        this.label.textContent = this.options.label ?? 'Buffering…';
        this.element.classList.toggle('has-label', !!this.label.textContent);
      },
      Math.max(this.delay, this.labelDelay),
    );
  }

  reset() {
    clearTimeout(this.showTimer);
    clearTimeout(this.labelTimer);
    this.waiting = false;
    this.engineWaiting = false;
    this.element.classList.remove('is-visible', 'has-label');
    this.element.setAttribute('aria-hidden', 'true');
    this.label.textContent = '';
  }

  destroy() {
    this.closed = true;
    this.reset();
    this.abort.abort();
    this.element.remove();
  }
}
