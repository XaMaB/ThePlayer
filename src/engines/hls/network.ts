import { HttpError, NetworkError, retryable, retryDelay } from './recovery';
import type { Resource } from './playlist';
export function httpAge(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}
function openRangeLength(header: string | null, offset: number) {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header ?? '');
  if (!match) throw new Error('Invalid HLS open range response');
  const start = Number(match[1]),
    end = Number(match[2]),
    total = match[3] === '*' ? undefined : Number(match[3]);
  if (
    start !== offset ||
    !Number.isSafeInteger(end) ||
    end < start ||
    (total != null && (!Number.isSafeInteger(total) || total <= end))
  )
    throw new Error('Invalid HLS open range response');
  return end - start + 1;
}
export interface NetworkOptions {
  transport?: 'fetch' | 'xhr';
  timeoutMs?: number;
  retries?: number;
  /** Total per-resource recovery budget; 0 uses only the retry count. Default 30 s. */
  recoveryWindowMs?: number;
  credentials?: RequestCredentials;
  /** Called per resource; scope credentials to the intended origin here. */
  headers?: (url: string) => Record<string, string>;
}
export interface RequestProgress {
  loaded: number;
  total?: number;
  elapsedMs: number;
}
export interface RequestOptions {
  headers?: Record<string, string>;
  /** Only callers retaining the exact representation may accept HTTP 304. */
  acceptNotModified?: boolean;
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  recoveryWindowMs?: number;
  onProgress?: (progress: RequestProgress) => void;
  /** Validated Fetch chunks for full-resource or speculative open-range delivery. */
  onChunk?: (chunk: Uint8Array, url: string) => void;
}
export interface ResourceResponse {
  status?: number;
  etag?: string;
  lastModified?: string;
  cmsd?: { static?: string; dynamic?: string };
  data: Uint8Array;
  url: string;
  elapsed: number;
  age?: number;
  receivedAt: number;
}
export class ResourceClient {
  bytes = 0;
  requests = 0;
  retries = 0;
  readonly recovery = {
    active: 0,
    attempts: 0,
    recovered: 0,
    exhausted: 0,
    lastError: '',
  };
  constructor(
    readonly options: NetworkOptions,
    readonly signal: AbortSignal,
    private readonly prefetched?: (
      resource: Resource,
    ) => ResourceResponse | undefined,
  ) {
    for (const [name, value, minimum] of [
      ['timeoutMs', options.timeoutMs, 1],
      ['retries', options.retries, 0],
      ['recoveryWindowMs', options.recoveryWindowMs, 0],
    ] as const) {
      if (
        value != null &&
        (!Number.isFinite(value) || value < minimum || !Number.isInteger(value))
      )
        throw new Error(`Invalid HLS ${name}`);
    }
    if (options.transport === 'xhr' && options.credentials === 'omit')
      throw new Error('Use Fetch to omit same-origin credentials');
  }
  async get(
    resource: Resource,
    request: RequestOptions = {},
  ): Promise<ResourceResponse> {
    this.signal.throwIfAborted();
    request.signal?.throwIfAborted();
    const cached = this.prefetched?.(resource);
    if (cached) return cached;
    const linked = request.signal ? new AbortController() : undefined;
    const stop = () => linked?.abort(this.signal.reason);
    const cancel = () => linked?.abort(request.signal!.reason);
    if (linked) {
      this.signal.addEventListener('abort', stop, { once: true });
      request.signal!.addEventListener('abort', cancel, { once: true });
      if (this.signal.aborted) stop();
      if (request.signal!.aborted) cancel();
    }
    const signal = linked?.signal ?? this.signal;
    const started = performance.now();
    const window =
      request.recoveryWindowMs ?? this.options.recoveryWindowMs ?? 30000;
    const deadline = window ? started + window : Infinity;
    let recovering = false;
    try {
      for (let attempt = 0; ; attempt++) {
        signal.throwIfAborted();
        try {
          const result = await this.once(
            resource,
            Math.min(
              request.timeoutMs ?? this.options.timeoutMs ?? 15000,
              Math.max(1, deadline - performance.now()),
            ),
            signal,
            request.onProgress,
            request.onChunk,
            request,
          );
          if (recovering) this.recovery.recovered++;
          return { ...result, elapsed: performance.now() - started };
        } catch (error) {
          signal.throwIfAborted();
          if (!retryable(error)) throw error;
          const wait = retryDelay(attempt);
          const extended =
            attempt >= (request.retries ?? this.options.retries ?? 2);
          if ((extended && !window) || performance.now() + wait >= deadline) {
            this.recovery.exhausted++;
            throw error;
          }
          this.recovery.lastError = (error as Error).message;
          if (extended) {
            if (!recovering) {
              recovering = true;
              this.recovery.active++;
            }
            this.recovery.attempts++;
          }
          this.retries++;
          await delay(wait, signal);
        }
      }
    } finally {
      if (recovering) this.recovery.active--;
      if (linked) {
        this.signal.removeEventListener('abort', stop);
        request.signal!.removeEventListener('abort', cancel);
      }
    }
  }
  private async once(
    resource: Resource,
    timeoutMs: number,
    signal: AbortSignal,
    progress?: (value: RequestProgress) => void,
    chunk?: (data: Uint8Array, url: string) => void,
    request: RequestOptions = {},
  ) {
    const controller = new AbortController();
    const stop = () => controller.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new DOMException('HLS request timed out', 'TimeoutError'),
        ),
      timeoutMs,
    );
    const start = performance.now();
    this.requests++;
    let loaded = 0,
      total: number | undefined;
    const notify = () => {
      if (controller.signal.aborted) return;
      try {
        progress?.({ loaded, total, elapsedMs: performance.now() - start });
      } catch (error) {
        controller.abort(error);
      }
    };
    const pulse = progress ? setInterval(notify, 250) : undefined;
    try {
      const headers = {
        ...request.headers,
        ...this.options.headers?.(resource.url),
      };
      if (resource.rangeStart != null)
        headers.Range = `bytes=${resource.rangeStart}-9007199254740991`;
      if (resource.range)
        headers.Range = `bytes=${resource.range.offset}-${resource.range.offset + resource.range.length - 1}`;
      let data: Uint8Array,
        url: string,
        status: number,
        contentRange: string | null,
        age: number | undefined,
        etag: string | undefined,
        lastModified: string | undefined,
        cmsd: { static?: string; dynamic?: string };
      if (this.options.transport === 'xhr') {
        const result = await new Promise<{
          data: Uint8Array;
          url: string;
          status: number;
          range: string | null;
          retryAfter: string | null;
          age?: number;
          etag?: string;
          lastModified?: string;
          cmsd: { static?: string; dynamic?: string };
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
          xhr.onload = () => {
            const exposed = new Set(
              xhr
                .getAllResponseHeaders()
                .split(/\r?\n/)
                .map((line) => line.split(':', 1)[0].toLowerCase()),
            );
            const optionalHeader = (name: string) =>
              exposed.has(name.toLowerCase())
                ? xhr.getResponseHeader(name)
                : null;
            resolve({
              data: new Uint8Array(xhr.response),
              url: xhr.responseURL,
              status: xhr.status,
              range: xhr.getResponseHeader('Content-Range'),
              retryAfter: xhr.getResponseHeader('Retry-After'),
              age: httpAge(xhr.getResponseHeader('Age')),
              etag: optionalHeader('ETag') ?? undefined,
              lastModified: optionalHeader('Last-Modified') ?? undefined,
              cmsd: {
                static: optionalHeader('CMSD-Static')?.slice(0, 8192),
                dynamic: optionalHeader('CMSD-Dynamic')?.slice(0, 8192),
              },
            });
          };
          xhr.onprogress = (event) => {
            loaded = event.loaded;
            total = event.lengthComputable ? event.total : undefined;
            notify();
            if (event.loaded > 64 * 1024 * 1024)
              controller.abort(new Error('HLS resource exceeds 64 MiB limit'));
          };
          xhr.onerror = () =>
            reject(new NetworkError('HLS network/CORS error'));
          xhr.onloadend = () =>
            controller.signal.removeEventListener('abort', cancel);
          if (controller.signal.aborted) cancel();
          else xhr.send();
        });
        ({ data, url, status } = result);
        contentRange = result.range;
        age = result.age;
        etag = result.etag;
        lastModified = result.lastModified;
        cmsd = result.cmsd;
        if (
          status === 304 &&
          request.acceptNotModified &&
          !resource.range &&
          resource.rangeStart == null
        )
          return {
            data: new Uint8Array(),
            url,
            status,
            etag,
            lastModified,
            age,
            elapsed: performance.now() - start,
            receivedAt: performance.now(),
          };
        if (status < 200 || status >= 300)
          throw new HttpError(status, result.retryAfter);
      } else {
        const response = await fetch(resource.url, {
          headers,
          signal: controller.signal,
          credentials: this.options.credentials ?? 'same-origin',
        });
        status = response.status;
        url = response.url;
        contentRange = response.headers.get('Content-Range');
        age = httpAge(response.headers.get('Age'));
        etag = response.headers.get('ETag') ?? undefined;
        lastModified = response.headers.get('Last-Modified') ?? undefined;
        cmsd = {
          static: response.headers.get('CMSD-Static')?.slice(0, 8192),
          dynamic: response.headers.get('CMSD-Dynamic')?.slice(0, 8192),
        };
        if (
          status === 304 &&
          request.acceptNotModified &&
          !resource.range &&
          resource.rangeStart == null
        )
          return {
            data: new Uint8Array(),
            url,
            status,
            etag,
            lastModified,
            age,
            elapsed: performance.now() - start,
            receivedAt: performance.now(),
          };
        const length = Number(response.headers.get('Content-Length'));
        total =
          length > 0 && !response.headers.get('Content-Encoding')
            ? length
            : undefined;
        if (!response.ok)
          throw new HttpError(status, response.headers.get('Retry-After'));
        const openLength =
          resource.rangeStart != null && status === 206
            ? openRangeLength(contentRange, resource.rangeStart)
            : undefined;
        if (resource.rangeStart != null && status !== 200 && status !== 206)
          throw new Error('Invalid HLS open range response');
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty HTTP response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.length;
            if (openLength != null && size > openLength)
              throw new Error('Open range response exceeds declared length');
            loaded = size;
            notify();
            controller.signal.throwIfAborted();
            if (size > 64 * 1024 * 1024) {
              await reader.cancel();
              throw new Error('HLS resource exceeds 64 MiB limit');
            }
            chunks.push(value);
            if (
              chunk &&
              resource.range == null &&
              (status === 200 || resource.rangeStart != null)
            ) {
              const skip =
                status === 200 && resource.rangeStart != null
                  ? Math.max(0, resource.rangeStart - (size - value.length))
                  : 0;
              if (skip < value.length) chunk(value.subarray(skip), url);
            }
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
      if (status < 200 || status >= 300) throw new HttpError(status);
      if (data.byteLength > 64 * 1024 * 1024)
        throw new Error('HLS resource exceeds 64 MiB limit');
      if (resource.rangeStart != null) {
        if (status === 200) {
          if (data.length < resource.rangeStart)
            throw new Error('Open range response is too short');
          data = data.slice(resource.rangeStart);
        } else if (
          status !== 206 ||
          data.length !== openRangeLength(contentRange, resource.rangeStart)
        )
          throw new Error('Invalid HLS open range response');
      }
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
      return {
        data,
        url,
        status,
        etag,
        lastModified,
        cmsd,
        elapsed: performance.now() - start,
        age,
        receivedAt: performance.now(),
      };
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof TypeError) throw new NetworkError(error.message);
      throw error;
    } finally {
      clearTimeout(timeout);
      if (pulse) clearInterval(pulse);
      signal.removeEventListener('abort', stop);
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
