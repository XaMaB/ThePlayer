import type { Track } from './mp4';

export interface DrmOptions {
  keySystem: string;
  /** Hexadecimal 16-byte KIDs and keys, for Clear Key testing or authorized clear-key delivery. */
  clearKeys?: Record<string, string>;
  /** The application owns license authentication and server selection. */
  license?: (
    message: Uint8Array,
    type: MediaKeyMessageType,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  serverCertificate?: Uint8Array;
  licenseTimeoutMs?: number;
  videoRobustness?: string;
  audioRobustness?: string;
}
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const hex = (value: string) => {
  if (!/^[0-9a-f]{32}$/i.test(value))
    throw new Error('Clear Key needs 16-byte hexadecimal KIDs and keys');
  return Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
};
/** Temporary EME sessions belong to one player lifetime; license requests are abortable. */
export class EmeController {
  private keys?: MediaKeys;
  private ready?: Promise<void>;
  private sessions = new Set<MediaKeySession>();
  private seen = new Set<string>();
  private abort = new AbortController();
  private configured = new Map<string, string>();
  constructor(
    private video: HTMLVideoElement,
    private options: DrmOptions,
    private fail: (error: unknown) => void,
  ) {
    if (!options.keySystem) throw new Error('Missing DRM key system');
    if (
      options.licenseTimeoutMs != null &&
      (!Number.isFinite(options.licenseTimeoutMs) ||
        options.licenseTimeoutMs < 1 ||
        options.licenseTimeoutMs > 120000)
    )
      throw new Error('Invalid DRM license timeout');
    if (options.clearKeys) {
      if (options.keySystem !== 'org.w3.clearkey')
        throw new Error('clearKeys requires org.w3.clearkey');
      for (const [id, key] of Object.entries(options.clearKeys))
        this.configured.set(base64url(hex(id)), base64url(hex(key)));
    }
    if (!options.license && !this.configured.size)
      throw new Error('DRM needs a license callback or Clear Key keys');
    video.addEventListener(
      'encrypted',
      (event) => {
        if (!event.initData) return;
        void this.open(
          event.initDataType,
          new Uint8Array(event.initData),
        ).catch((error) => this.report(error));
      },
      { signal: this.abort.signal },
    );
  }
  private async license(
    message: Uint8Array,
    type: MediaKeyMessageType,
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const stop = () => controller.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', stop, { once: true });
    if (this.abort.signal.aborted) stop();
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const timer = setTimeout(
      () => controller.abort(new Error('DRM license request timed out')),
      this.options.licenseTimeoutMs ?? 15000,
    );
    try {
      return await Promise.race([
        this.options.license!(message, type, controller.signal),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', stop);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
  addClearKeys(keys: Record<string, string>) {
    if (this.options.keySystem !== 'org.w3.clearkey')
      throw new Error('Identity keys require the Clear Key CDM');
    for (const [id, key] of Object.entries(keys))
      this.configured.set(base64url(hex(id)), base64url(hex(key)));
  }
  async requestKeyIds(tracks: Track[]) {
    await this.ensure(tracks);
    const kids = [
      ...new Set(
        tracks
          .filter((t) => t.encryption)
          .map((t) => base64url(t.encryption!.kid)),
      ),
    ].sort();
    await this.open(
      'keyids',
      new TextEncoder().encode(JSON.stringify({ kids })),
    );
  }
  private report(error: unknown) {
    if (!this.abort.signal.aborted) this.fail(error);
  }
  async ensure(tracks: Track[]) {
    if (!tracks.some((t) => t.encryption)) return;
    if (!this.ready) this.ready = this.initialize(tracks);
    await this.ready;
    this.abort.signal.throwIfAborted();
  }
  private async initialize(tracks: Track[]) {
    if (!navigator.requestMediaKeySystemAccess)
      throw new Error('EME requires a supported browser and secure context');
    const capabilities = (kind: 'video' | 'audio') =>
      tracks
        .filter((t) => t.kind === kind)
        .map((t) => ({
          contentType: `${kind}/mp4; codecs="${t.codec}"`,
          encryptionScheme: t.encryption?.scheme,
          robustness:
            kind === 'video'
              ? this.options.videoRobustness
              : this.options.audioRobustness,
        }));
    const config: MediaKeySystemConfiguration = {
      initDataTypes: ['cenc', 'keyids'],
      sessionTypes: ['temporary'],
      persistentState: 'not-allowed',
      distinctiveIdentifier: 'not-allowed',
      videoCapabilities: capabilities('video'),
      audioCapabilities: capabilities('audio'),
    };
    const access = await navigator.requestMediaKeySystemAccess(
      this.options.keySystem,
      [config],
    );
    this.abort.signal.throwIfAborted();
    const keys = await access.createMediaKeys();
    this.abort.signal.throwIfAborted();
    if (this.options.serverCertificate) {
      const supported = await keys.setServerCertificate(
        this.options.serverCertificate as BufferSource,
      );
      if (!supported) throw new Error('CDM rejected the server certificate');
    }
    this.abort.signal.throwIfAborted();
    await this.video.setMediaKeys(keys);
    if (this.abort.signal.aborted) {
      if (this.video.mediaKeys === keys) await this.video.setMediaKeys(null);
      this.abort.signal.throwIfAborted();
    }
    this.keys = keys;
  }
  private async open(type: string, bytes: Uint8Array) {
    if (!this.ready)
      throw new Error('Encrypted event arrived before DRM configuration');
    await this.ready;
    this.abort.signal.throwIfAborted();
    if (bytes.length > 65536)
      throw new Error('DRM initialization data exceeds 64 KiB');
    const id = type + ':' + base64url(bytes);
    if (this.seen.has(id)) return;
    if (this.sessions.size >= 64)
      throw new Error('Too many simultaneous DRM sessions');
    this.seen.add(id);
    const session = this.keys!.createSession('temporary');
    this.sessions.add(session);
    let messages = Promise.resolve();
    session.addEventListener(
      'message',
      (event) => {
        messages = messages
          .then(async () => {
            this.abort.signal.throwIfAborted();
            let response: Uint8Array;
            if (this.options.license)
              response = await this.license(
                new Uint8Array(event.message),
                event.messageType,
              );
            else {
              const request = JSON.parse(
                new TextDecoder().decode(event.message),
              );
              if (
                !Array.isArray(request.kids) ||
                !request.kids.length ||
                request.kids.length > 64
              )
                throw new Error('Invalid Clear Key request');
              const keys = request.kids.map((kid: string) => {
                const k = this.configured.get(kid);
                if (!k)
                  throw new Error('No configured Clear Key for requested KID');
                return { kty: 'oct', kid, k };
              });
              response = new TextEncoder().encode(
                JSON.stringify({ keys, type: 'temporary' }),
              );
            }
            this.abort.signal.throwIfAborted();
            await session.update(response as BufferSource);
          })
          .catch((error) => this.report(error));
      },
      { signal: this.abort.signal },
    );
    session.addEventListener(
      'keystatuseschange',
      () => {
        for (const status of session.keyStatuses.values())
          if (
            ['expired', 'output-restricted', 'internal-error'].includes(status)
          )
            this.report(new Error('DRM key status: ' + status));
      },
      { signal: this.abort.signal },
    );
    try {
      await session.generateRequest(type, bytes as BufferSource);
    } catch (error) {
      this.seen.delete(id);
      this.sessions.delete(session);
      await session.close().catch(() => {});
      throw error;
    }
  }
  async destroy() {
    this.abort.abort();
    await Promise.allSettled(
      [...this.sessions].map((session) => session.close()),
    );
    this.sessions.clear();
    this.seen.clear();
    this.configured.clear();
    if (this.keys && this.video.mediaKeys === this.keys)
      await this.video.setMediaKeys(null);
    this.keys = undefined;
  }
}
