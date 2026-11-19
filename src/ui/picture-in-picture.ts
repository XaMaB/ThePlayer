export interface PictureInPictureOptions {
  /** Prefer Document PiP, then native video PiP. Default: auto. */
  mode?: 'auto' | 'document' | 'video';
  /** Register the browser-driven Media Session action. Default: false. */
  automatic?: boolean;
  width?: number;
  height?: number;
}
type SafariVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitPresentationMode?: string;
};
type PipWindow = Window & {
  documentPictureInPicture?: {
    requestWindow(options: { width: number; height: number }): Promise<Window>;
  };
};
// Media Session belongs to the page, not an individual player.
const automaticOwners = new WeakMap<Window, Set<PictureInPictureController>>();

/** Move the existing screen/video; never create a second decoder or transport. */
export class PictureInPictureController {
  private readonly origin: Document;
  private readonly host: PipWindow;
  private readonly video: SafariVideo;
  private readonly abort = new AbortController();
  private pipWindow?: Window;
  private placeholder?: HTMLElement;
  private parent?: Node;
  private sibling?: Node | null;
  private busy = false;
  private disposed = false;
  private automatic = false;
  private automaticActive = false;
  private readonly mode: 'auto' | 'document' | 'video';
  private readonly width: number;
  private readonly height: number;
  constructor(
    private readonly screen: HTMLElement,
    video: HTMLVideoElement,
    options: PictureInPictureOptions = {},
    private readonly changed: () => void = () => {},
  ) {
    this.origin = screen.ownerDocument;
    this.host = this.origin.defaultView! as PipWindow;
    this.video = video;
    this.mode = options.mode ?? 'auto';
    this.width = options.width ?? 560;
    this.height = options.height ?? 315;
    if (!['auto', 'document', 'video'].includes(this.mode))
      throw new TypeError('Invalid Picture-in-Picture mode');
    for (const size of [this.width, this.height])
      if (!Number.isFinite(size) || size < 1 || size > 16384)
        throw new RangeError('PiP dimensions must be between 1 and 16384');
    for (const event of [
      'enterpictureinpicture',
      'leavepictureinpicture',
      'webkitpresentationmodechanged',
      'loadedmetadata',
      'emptied',
    ])
      video.addEventListener(
        event,
        () => {
          if (event === 'emptied') void this.exit().catch(() => {});
          changed();
        },
        { signal: this.abort.signal },
      );
    video.addEventListener(
      'play',
      () => {
        const owners = automaticOwners.get(this.host);
        if (owners?.has(this)) {
          owners.delete(this);
          owners.add(this);
        }
      },
      { signal: this.abort.signal },
    );
    this.origin.addEventListener(
      'visibilitychange',
      () => {
        if (!this.origin.hidden && this.automaticActive)
          void this.exit().catch(() => {});
      },
      { signal: this.abort.signal },
    );
    this.host.addEventListener('pagehide', () => this.destroy(), {
      signal: this.abort.signal,
    });
    this.setAutomatic(options.automatic ?? false);
  }
  get supported(): boolean {
    return this.documentSupported || this.nativeSupported;
  }
  private get documentSupported(): boolean {
    return (
      !this.video.disablePictureInPicture &&
      this.mode !== 'video' &&
      !!this.host.documentPictureInPicture?.requestWindow &&
      this.host.top === this.host
    );
  }
  private get nativeSupported(): boolean {
    if (this.mode === 'document' || this.video.disablePictureInPicture)
      return false;
    return (
      (!!this.origin.pictureInPictureEnabled &&
        typeof this.video.requestPictureInPicture === 'function') ||
      !!this.video.webkitSupportsPresentationMode?.('picture-in-picture')
    );
  }
  get active(): boolean {
    return (
      !!this.pipWindow ||
      this.origin.pictureInPictureElement === this.video ||
      this.video.webkitPresentationMode === 'picture-in-picture'
    );
  }
  get kind(): 'document' | 'video' | 'none' {
    return this.pipWindow ? 'document' : this.active ? 'video' : 'none';
  }
  get automaticEnabled(): boolean {
    return this.automatic;
  }
  setAutomatic(enabled: boolean): boolean {
    if (this.disposed) return false;
    let owners = automaticOwners.get(this.host);
    if (!enabled) {
      owners?.delete(this);
      this.automatic = false;
      if (owners?.size === 0) {
        try {
          this.host.navigator.mediaSession?.setActionHandler(
            'enterpictureinpicture' as MediaSessionAction,
            null,
          );
        } catch {
          /* Unsupported action. */
        }
        automaticOwners.delete(this.host);
      }
      return false;
    }
    if (!this.host.navigator.mediaSession || this.host.top !== this.host)
      return false;
    if (!owners) {
      owners = new Set();
      const candidates = owners;
      try {
        this.host.navigator.mediaSession.setActionHandler(
          'enterpictureinpicture' as MediaSessionAction,
          () => {
            const owner = [...candidates]
              .reverse()
              .find(
                (item) =>
                  !item.disposed &&
                  !item.video.paused &&
                  item.video.videoWidth > 0,
              );
            if (owner) void owner.enter(true).catch(() => {});
          },
        );
      } catch {
        return false;
      }
      automaticOwners.set(this.host, owners);
    }
    owners.add(this);
    this.automatic = true;
    return true;
  }
  async toggle(): Promise<void> {
    if (this.active) await this.exit();
    else await this.enter();
  }
  async enter(automatic = false): Promise<void> {
    if (this.disposed || this.busy || this.active) return;
    if (this.video.readyState < 1 || !this.video.videoWidth)
      throw new Error('Play a video before opening Picture-in-Picture');
    this.busy = true;
    try {
      if (this.documentSupported) {
        try {
          const popup = await this.host.documentPictureInPicture!.requestWindow(
            { width: this.width, height: this.height },
          );
          if (this.disposed) {
            popup.close();
            return;
          }
          this.pipWindow = popup;
          this.parent = this.screen.parentNode!;
          this.sibling = this.screen.nextSibling;
          this.placeholder = this.origin.createElement('div');
          this.placeholder.className = 'pip-placeholder';
          this.placeholder.setAttribute('role', 'status');
          this.placeholder.textContent = 'Playing in Picture-in-Picture';
          this.placeholder.style.aspectRatio = `${this.screen.clientWidth || 16} / ${this.screen.clientHeight || 9}`;
          this.screen.before(this.placeholder);
          const doc = popup.document;
          doc.title = 'ThePlayer';
          const base = doc.createElement('base');
          base.href = this.origin.baseURI;
          doc.head.append(base);
          // Clone links/styles, not their text through cssRules (cross-origin sheets can be opaque).
          for (const node of this.origin.querySelectorAll(
            'link[rel="stylesheet"], style',
          ))
            doc.head.append(node.cloneNode(true));
          for (const sheet of this.origin.adoptedStyleSheets) {
            const style = doc.createElement('style');
            style.textContent = Array.from(
              sheet.cssRules,
              (rule) => rule.cssText,
            ).join('\n');
            doc.head.append(style);
          }
          doc.documentElement.className = this.origin.documentElement.className;
          doc.body.className = this.origin.body.className;
          doc.body.dataset.theplayerPip = '';
          const style = doc.createElement('style');
          style.textContent =
            'html,body{margin:0!important;padding:0!important;width:100%;height:100%;overflow:hidden;background:#000}body>.screen,body>[data-theplayer-pip-screen]{width:100%!important;height:100%!important;aspect-ratio:auto!important;border-radius:0!important}#fullscreen{display:none!important}';
          doc.head.append(style);
          popup.addEventListener('pagehide', () => this.restore(), {
            once: true,
          });
          this.screen.setAttribute('data-theplayer-pip-screen', '');
          doc.body.append(this.screen);
          this.documentChanged();
          this.automaticActive = automatic;
          this.changed();
          return;
        } catch (error) {
          if (this.pipWindow) {
            const popup = this.pipWindow;
            this.restore();
            popup.close();
          }
          // Permission denials must not trigger another API prompt.
          if (
            this.mode !== 'auto' ||
            (error as Error).name !== 'NotSupportedError'
          )
            throw error;
        }
      }
      if (!this.nativeSupported)
        throw new Error(
          'Picture-in-Picture is unavailable in this browser or embedding context',
        );
      if (
        this.origin.pictureInPictureEnabled &&
        this.video.requestPictureInPicture
      )
        await this.video.requestPictureInPicture();
      else this.video.webkitSetPresentationMode!('picture-in-picture');
      this.automaticActive = automatic;
      if (this.disposed) await this.exit();
      this.changed();
    } finally {
      this.busy = false;
    }
  }
  private documentChanged() {
    this.screen.dispatchEvent(new Event('theplayerdocumentchange'));
    this.video.dispatchEvent(new Event('theplayerdocumentchange'));
  }
  private restore() {
    if (!this.pipWindow) return;
    if (this.placeholder?.parentNode) this.placeholder.replaceWith(this.screen);
    else if (this.parent)
      this.parent.insertBefore(
        this.screen,
        this.sibling?.parentNode === this.parent ? this.sibling : null,
      );
    this.placeholder?.remove();
    this.placeholder = undefined;
    this.pipWindow = undefined;
    this.screen.removeAttribute('data-theplayer-pip-screen');
    this.automaticActive = false;
    this.documentChanged();
    this.changed();
  }
  async exit(): Promise<void> {
    this.automaticActive = false;
    if (this.pipWindow) {
      const popup = this.pipWindow;
      this.restore();
      popup.close();
    }
    if (this.origin.pictureInPictureElement === this.video)
      await this.origin.exitPictureInPicture();
    if (this.video.webkitPresentationMode === 'picture-in-picture')
      this.video.webkitSetPresentationMode?.('inline');
    this.changed();
  }
  destroy(): void {
    if (this.disposed) return;
    this.setAutomatic(false);
    this.disposed = true;
    this.abort.abort();
    void this.exit().catch(() => {});
  }
}
