export class NativeRemotePlayback extends EventTarget {
  private watch?: number;
  private closed = false;
  private available = false;
  private abort = new AbortController();
  constructor(readonly video: HTMLVideoElement) {
    super();
    const remote = video.remote;
    if (remote) {
      for (const event of ['connect', 'connecting', 'disconnect'])
        remote.addEventListener(
          event,
          () => this.dispatchEvent(new Event('change')),
          { signal: this.abort.signal },
        );
      if (typeof remote.watchAvailability === 'function')
        void remote
          .watchAvailability((available) => {
            this.available = available;
            this.dispatchEvent(new Event('change'));
          })
          .then((id) => {
            if (this.closed)
              void remote.cancelWatchAvailability(id).catch(() => {});
            else this.watch = id;
          })
          .catch(() => {});
    }
    video.addEventListener(
      'webkitplaybacktargetavailabilitychanged',
      (event: any) => {
        this.available = event.availability === 'available';
        this.dispatchEvent(new Event('change'));
      },
      { signal: this.abort.signal },
    );
  }
  get supported() {
    return (
      !this.video.disableRemotePlayback && (this.available || this.connected)
    );
  }
  get connected() {
    return (
      this.video.remote?.state === 'connected' ||
      !!(this.video as any).webkitCurrentPlaybackTargetIsWireless
    );
  }
  async prompt() {
    if (!this.supported)
      throw new Error('No compatible remote playback target is available');
    const video = this.video as HTMLVideoElement & {
      webkitShowPlaybackTargetPicker?: () => void;
    };
    if (video.webkitShowPlaybackTargetPicker)
      video.webkitShowPlaybackTargetPicker();
    else await video.remote.prompt();
  }
  destroy() {
    this.closed = true;
    this.abort.abort();
    if (this.watch !== undefined)
      void this.video.remote
        .cancelWatchAvailability(this.watch)
        .catch(() => {});
  }
}
export interface CastMedia {
  url: string;
  contentType: string;
  title?: string;
  live?: boolean;
  /** Application-specific receiver data; e.g. authenticated DRM receiver configuration. */
  customData?: unknown;
}
export interface CastSenderOptions {
  receiverApplicationId?: string;
  /** Supply a receiver-accessible URL. Local blob/MSE/MoQ objects cannot be cast. */
  media: () => CastMedia | undefined;
}
/** Adapter for an application-loaded Google Cast Web Sender SDK. */
export class CastSender extends EventTarget {
  private context: any;
  private host: any;
  private controller: any;
  private remote: any;
  private closed = false;
  private change = () => this.dispatchEvent(new Event('change'));
  constructor(
    private video: HTMLVideoElement,
    private options: CastSenderOptions,
  ) {
    super();
    const host = (this.host = video.ownerDocument.defaultView as any);
    const framework = host.cast?.framework,
      chrome = host.chrome?.cast;
    if (!framework || !chrome)
      throw new Error(
        'Load the Google Cast Web Sender SDK before creating CastSender',
      );
    this.context = framework.CastContext.getInstance();
    this.context.setOptions({
      receiverApplicationId:
        options.receiverApplicationId ??
        chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    this.remote = new framework.RemotePlayer();
    this.controller = new framework.RemotePlayerController(this.remote);
    this.context.addEventListener(
      framework.CastContextEventType.CAST_STATE_CHANGED,
      this.change,
    );
    this.controller.addEventListener(
      framework.RemotePlayerEventType.ANY_CHANGE,
      this.change,
    );
  }
  get supported() {
    return (
      !this.closed &&
      this.context.getCastState() !== 'NO_DEVICES_AVAILABLE' &&
      !!this.options.media()
    );
  }
  get connected() {
    return !this.closed && !!this.remote.isConnected;
  }
  get paused() {
    return !!this.remote.isPaused;
  }
  async connect() {
    if (this.closed) throw new Error('Cast sender has been destroyed');
    const media = this.options.media();
    if (!media) throw new Error('No Cast-compatible media URL is configured');
    const url = new URL(media.url);
    if (!['https:', 'http:'].includes(url.protocol))
      throw new Error('Cast requires a receiver-accessible HTTP(S) URL');
    const host = this.host,
      api = host.chrome.cast.media;
    // Must be called from a user gesture before awaiting anything else.
    await this.context.requestSession();
    if (this.closed) return;
    const info = new api.MediaInfo(url.href, media.contentType);
    info.streamType = media.live
      ? api.StreamType.LIVE
      : api.StreamType.BUFFERED;
    info.metadata = new api.GenericMediaMetadata();
    info.metadata.title = media.title ?? 'ThePlayer';
    if (media.customData !== undefined) info.customData = media.customData;
    const request = new api.LoadRequest(info);
    request.autoplay = true;
    if (!media.live && Number.isFinite(this.video.currentTime))
      request.currentTime = this.video.currentTime;
    await this.context.getCurrentSession().loadMedia(request);
    if (!this.closed) this.video.pause();
    this.change();
  }
  togglePlay() {
    if (this.connected) this.controller.playOrPause();
  }
  disconnect() {
    if (!this.closed) this.context.endCurrentSession(true);
  }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    const framework = this.host.cast.framework;
    this.context.removeEventListener(
      framework.CastContextEventType.CAST_STATE_CHANGED,
      this.change,
    );
    this.controller.removeEventListener(
      framework.RemotePlayerEventType.ANY_CHANGE,
      this.change,
    );
    // Do not terminate a shared receiver session when an individual UI is removed.
  }
}
let sdk: Promise<void> | undefined;
/** Explicit opt-in: no SDK download occurs merely by importing ThePlayer. */
export function loadCastSdk(): Promise<void> {
  if ((window as any).cast?.framework) return Promise.resolve();
  if (sdk) return sdk;
  sdk = new Promise<void>((resolve, reject) => {
    const host = window as any,
      previous = host.__onGCastApiAvailable;
    const script = document.createElement('script');
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      if (host.__onGCastApiAvailable === callback)
        host.__onGCastApiAvailable = previous;
      script.onerror = null;
      if (error) {
        script.remove();
        reject(error);
      } else resolve();
    };
    const callback = (available: boolean, ...args: any[]) => {
      try {
        previous?.(available, ...args);
      } finally {
        finish(
          available
            ? undefined
            : new Error('Google Cast SDK is unavailable in this browser'),
        );
      }
    };
    host.__onGCastApiAvailable = callback;
    script.src =
      'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
    script.async = true;
    script.onerror = () =>
      finish(new Error('Could not load the Google Cast SDK'));
    timer = setTimeout(
      () => finish(new Error('Google Cast SDK initialization timed out')),
      15000,
    );
    document.head.append(script);
  }).catch((error) => {
    sdk = undefined;
    throw error;
  });
  return sdk;
}
