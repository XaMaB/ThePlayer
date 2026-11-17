import type { Resource } from './playlist';
export interface NetworkOptions {
  transport?: 'fetch' | 'xhr';
  timeoutMs?: number;
  retries?: number;
  credentials?: RequestCredentials;
  /** Called per resource; scope credentials to the intended origin here. */
  headers?: (url: string) => Record<string, string>;
}
export class ResourceClient {
  bytes = 0;
  requests = 0;
  retries = 0;
  constructor(
    readonly options: NetworkOptions,
    readonly signal: AbortSignal,
  ) {
    if (options.transport === 'xhr' && options.credentials === 'omit')
      throw new Error('Use Fetch to omit same-origin credentials');
  }
  async get(
    resource: Resource,
  ): Promise<{ data: Uint8Array; url: string; elapsed: number }> {
    let last: unknown;
    const started = performance.now();
    for (let attempt = 0; attempt <= (this.options.retries ?? 2); attempt++) {
      this.signal.throwIfAborted();
      try {
        const result = await this.once(resource);
        return { ...result, elapsed: performance.now() - started };
      } catch (error) {
        last = error;
        this.signal.throwIfAborted();
        if (attempt === (this.options.retries ?? 2)) break;
        this.retries++;
        await delay(Math.min(4000, 300 * 2 ** attempt), this.signal);
      }
    }
    throw last;
  }
  private async once(resource: Resource) {
    const controller = new AbortController();
    const stop = () => controller.abort(this.signal.reason);
    this.signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException('HLS request timed out', 'TimeoutError'),
        ),
      this.options.timeoutMs ?? 15000,
    );
    const start = performance.now();
    this.requests++;
    const headers = { ...this.options.headers?.(resource.url) };
    if (resource.range)
      headers.Range = `bytes=${resource.range.offset}-${resource.range.offset + resource.range.length - 1}`;
    try {
      let data: Uint8Array,
        url: string,
        status: number,
        contentRange: string | null;
      if (this.options.transport === 'xhr') {
        const result = await new Promise<{
          data: Uint8Array;
          url: string;
          status: number;
          range: string | null;
        }>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const cancel = () => {
            xhr.abort();
            reject(controller.signal.reason);
          };
          controller.signal.addEventListener('abort', cancel, { once: true });
          xhr.open('GET', resource.url);
          xhr.responseType = 'arraybuffer';
          xhr.withCredentials = this.options.credentials === 'include';
          for (const [name, value] of Object.entries(headers))
            xhr.setRequestHeader(name, value);
          xhr.onload = () =>
            resolve({
              data: new Uint8Array(xhr.response),
              url: xhr.responseURL,
              status: xhr.status,
              range: xhr.getResponseHeader('Content-Range'),
            });
          xhr.onprogress = (event) => {
            if (event.loaded > 64 * 1024 * 1024)
              controller.abort(new Error('HLS resource exceeds 64 MiB limit'));
          };
          xhr.onerror = () => reject(new Error('HLS network/CORS error'));
          xhr.onloadend = () =>
            controller.signal.removeEventListener('abort', cancel);
          if (controller.signal.aborted) cancel();
          else xhr.send();
        });
        ({ data, url, status } = result);
        contentRange = result.range;
      } else {
        const response = await fetch(resource.url, {
          headers,
          signal: controller.signal,
          credentials: this.options.credentials ?? 'same-origin',
        });
        status = response.status;
        url = response.url;
        contentRange = response.headers.get('Content-Range');
        if (!response.ok) throw new Error(`HLS HTTP ${status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty HTTP response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 64 * 1024 * 1024) {
              await reader.cancel();
              throw new Error('HLS resource exceeds 64 MiB limit');
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        data = new Uint8Array(size);
        let at = 0;
        for (const chunk of chunks) {
          data.set(chunk, at);
          at += chunk.length;
        }
      }
      if (status < 200 || status >= 300) throw new Error(`HLS HTTP ${status}`);
      if (data.byteLength > 64 * 1024 * 1024)
        throw new Error('HLS resource exceeds 64 MiB limit');
      if (resource.range) {
        if (status === 200) {
          const { offset, length } = resource.range;
          if (data.length < offset + length)
            throw new Error('Range response is too short');
          data = data.slice(offset, offset + length);
        } else if (
          status !== 206 ||
          data.length !== resource.range.length ||
          (contentRange &&
            !contentRange.startsWith(`bytes ${resource.range.offset}-`))
        )
          throw new Error('Invalid HLS byte range response');
      }
      this.bytes += data.length;
      return { data, url, elapsed: performance.now() - start };
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener('abort', stop);
    }
  }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      resolve();
    }, ms);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
