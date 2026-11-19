/** Capture the decoded video only; custom subtitle/DOM overlays are not composited. */
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  if (video.mediaKeys)
    throw new Error('Frame capture is unavailable for DRM-protected video');
  if (video.readyState < 2 || !video.videoWidth)
    throw new Error('No decoded video frame is available');
  const canvas = video.ownerDocument.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas frame capture is unavailable');
  try {
    context.drawImage(video, 0, 0);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error('The browser could not encode this frame')),
        'image/png',
      ),
    );
  } catch (error) {
    if ((error as Error).name === 'SecurityError')
      throw new Error(
        'Frame capture requires media served with compatible CORS permissions',
      );
    throw error;
  } finally {
    canvas.width = canvas.height = 0;
  }
}
export async function downloadFrame(
  video: HTMLVideoElement,
  filename = 'theplayer-frame.png',
) {
  const blob = await captureFrame(video);
  const url = URL.createObjectURL(blob);
  const link = video.ownerDocument.createElement('a');
  link.href = url;
  link.download = filename;
  video.ownerDocument.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function copyFrame(video: HTMLVideoElement): Promise<void> {
  const host = video.ownerDocument.defaultView!;
  if (!host.navigator.clipboard?.write || !('ClipboardItem' in host))
    return Promise.reject(
      new Error('Copy frame is unavailable in this browser'),
    );
  // Pass a promise immediately, retaining user activation in browsers such as Safari.
  return host.navigator.clipboard.write([
    new ClipboardItem({ 'image/png': captureFrame(video) }),
  ]);
}
