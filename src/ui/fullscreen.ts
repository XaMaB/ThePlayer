type VideoFullscreen = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitEnterFullScreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitExitFullScreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
};
type ElementFullscreen = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
  webkitRequestFullScreen?: () => void | Promise<void>;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void | Promise<void>;
  webkitCancelFullScreen?: () => void | Promise<void>;
};

/** Prefer container fullscreen; iPhone falls back to native video fullscreen. */
export class FullscreenController extends EventTarget {
  private readonly abort = new AbortController();
  private documentAbort = new AbortController();
  private nativeActive = false;
  private closed = false;

  constructor(
    private readonly screen: ElementFullscreen,
    private readonly video: VideoFullscreen,
  ) {
    super();
    const listen = (name: string, handler: () => void) =>
      video.addEventListener(name, handler, { signal: this.abort.signal });
    for (const name of [
      'loadedmetadata',
      'loadeddata',
      'canplay',
      'playing',
      'resize',
      'webkitpresentationmodechanged',
    ])
      listen(name, () => this.changed());
    listen('webkitbeginfullscreen', () => {
      this.nativeActive = true;
      this.changed();
    });
    listen('webkitendfullscreen', () => {
      this.nativeActive = false;
      this.changed();
    });
    for (const name of ['emptied', 'loadstart'])
      listen(name, () => {
        this.nativeActive = false;
        this.changed();
      });
    screen.addEventListener(
      'theplayerdocumentchange',
      () => this.bindDocument(),
      { signal: this.abort.signal },
    );
    this.bindDocument();
  }

  private get document(): FullscreenDocument {
    return this.screen.ownerDocument;
  }
  private get mode() {
    if (typeof this.screen.requestFullscreen === 'function') return 'element';
    if (
      typeof (
        this.screen.webkitRequestFullscreen ??
        this.screen.webkitRequestFullScreen
      ) === 'function'
    )
      return 'webkit-element';
    if (
      typeof (
        this.video.webkitEnterFullscreen ?? this.video.webkitEnterFullScreen
      ) === 'function'
    )
      return 'video';
    if (
      typeof this.video.webkitSetPresentationMode === 'function' &&
      this.video.webkitSupportsPresentationMode?.('fullscreen')
    )
      return 'presentation';
    return undefined;
  }
  get supported() {
    return !!this.mode;
  }
  get active() {
    return (
      this.document.fullscreenElement === this.screen ||
      this.document.webkitFullscreenElement === this.screen ||
      this.nativeActive ||
      !!this.video.webkitDisplayingFullscreen ||
      this.video.webkitPresentationMode === 'fullscreen'
    );
  }
  get available() {
    if (this.closed) return false;
    if (this.active) return true;
    if (this.mode === 'element')
      return this.document.fullscreenEnabled !== false;
    if (this.mode === 'webkit-element')
      return this.document.webkitFullscreenEnabled !== false;
    return (
      !!this.mode &&
      this.video.readyState >= 1 &&
      this.video.videoWidth > 0 &&
      this.video.webkitSupportsFullscreen !== false
    );
  }

  /** Invoke directly from a click/key gesture; never queue a later automatic entry. */
  async toggle() {
    if (!this.available) return;
    if (this.active) await this.exit();
    else if (this.mode === 'element') await this.screen.requestFullscreen();
    else if (this.mode === 'webkit-element')
      await (this.screen.webkitRequestFullscreen ??
        this.screen.webkitRequestFullScreen)!.call(this.screen);
    else if (this.mode === 'video')
      (this.video.webkitEnterFullscreen ??
        this.video.webkitEnterFullScreen)!.call(this.video);
    else if (this.mode === 'presentation')
      this.video.webkitSetPresentationMode!('fullscreen');
    this.changed();
  }
  private async exit() {
    if (this.document.fullscreenElement === this.screen)
      await this.document.exitFullscreen();
    else if (this.document.webkitFullscreenElement === this.screen)
      await (
        this.document.webkitExitFullscreen ??
        this.document.webkitCancelFullScreen
      )?.call(this.document);
    else if (
      this.video.webkitPresentationMode === 'fullscreen' &&
      this.video.webkitSetPresentationMode
    )
      this.video.webkitSetPresentationMode('inline');
    else
      (
        this.video.webkitExitFullscreen ?? this.video.webkitExitFullScreen
      )?.call(this.video);
  }
  private changed() {
    if (!this.closed) this.dispatchEvent(new Event('change'));
  }
  private bindDocument() {
    this.documentAbort.abort();
    this.documentAbort = new AbortController();
    for (const name of [
      'fullscreenchange',
      'webkitfullscreenchange',
      'fullscreenerror',
      'webkitfullscreenerror',
    ])
      this.document.addEventListener(name, () => this.changed(), {
        signal: this.documentAbort.signal,
      });
    this.changed();
  }
  destroy() {
    if (this.closed) return;
    if (this.active) void this.exit().catch(() => {});
    this.closed = true;
    this.abort.abort();
    this.documentAbort.abort();
  }
}
