/** Use ordinary MSE where available, and Apple's iPhone media-source API otherwise. */
export function mediaSourceConstructor(): typeof MediaSource {
  const host = globalThis as typeof globalThis & {
    ManagedMediaSource?: typeof MediaSource;
  };
  const constructor = host.MediaSource ?? host.ManagedMediaSource;
  if (!constructor)
    throw new Error(
      'This browser requires MediaSource or ManagedMediaSource for playback',
    );
  return constructor;
}

export function supportsMediaType(mime: string): boolean {
  return mediaSourceConstructor().isTypeSupported(mime);
}

const remotePlayback = new WeakMap<HTMLVideoElement, boolean>();

export function createMediaSource(video: HTMLVideoElement): MediaSource {
  const Constructor = mediaSourceConstructor();
  video.playsInline = true;
  if (Constructor !== globalThis.MediaSource) {
    // Without an AirPlay alternative Safari requires this before attachment.
    if (!remotePlayback.has(video))
      remotePlayback.set(video, video.disableRemotePlayback);
    video.disableRemotePlayback = true;
  }
  return new Constructor();
}

export function releaseMediaSource(video: HTMLVideoElement): void {
  if (!remotePlayback.has(video)) return;
  video.disableRemotePlayback = remotePlayback.get(video)!;
  remotePlayback.delete(video);
}
