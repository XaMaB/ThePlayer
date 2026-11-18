/** Abortable MSE operations shared by the DASH scheduler and switching path. */
export function mediaEvent(
  target: EventTarget,
  event: string,
  signal: AbortSignal,
  action?: () => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(event, done);
      target.removeEventListener('error', failed);
      signal.removeEventListener('abort', aborted);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const failed = () => {
      cleanup();
      reject(new Error('DASH media operation failed'));
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('DASH media operation timed out'));
    }, 15000);
    target.addEventListener(event, done, { once: true });
    target.addEventListener('error', failed, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
    try {
      action?.();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
