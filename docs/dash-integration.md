# DASH integration

The [support matrix](dash-support.md) defines the implemented preview profiles and remaining limits. This guide describes the public API; availability of an option does not certify every codec, CDM or device.

## Load and destroy

```js
import { ThePlayer } from './dist/player.js';

const player = new ThePlayer(document.querySelector('video'));
player.addEventListener('error', (event) => reportError(event.detail));
player.addEventListener('autoplayblocked', () => showPlayButton());
await player.load({
  protocol: 'dash',
  url: 'https://media.example.com/channel/manifest.mpd',
  quality: 'auto',
  targetBuffer: 12,
  audioLanguage: 'en',
});

// Later, when removing this player:
await player.destroy();
```

`reportError` and `showPlayButton` are application callbacks. Attach listeners before `load()`. Initialization can reject its promise; errors after initialization arrive through `error`. Browser autoplay rules still apply. `load()` resolves after initialization, not after the first rendered frame.

For DASH-only delivery without importing the MoQ stack:

```js
import { PlayerCore } from './dist/core.js';
import { DashEngine } from './dist/dash.js';

const player = new PlayerCore(video, {
  dash: (element, source) => new DashEngine(element, source),
});
await player.load({ protocol: 'dash', url: manifestUrl });
```

Build with `npm run build` and deploy **all of `dist/`**, including `chunks/`. Bundles are generated artifacts, not files stored in the source repository. `dash.js` exports `DashEngine`; its TypeScript source contract is `DashSource` in `src/engines/dash/engine.ts`; `core.js` supplies the registry/lifecycle. The default `player.js` lazily loads DASH.

## Source options

| Option                 | Default                     | Meaning                                                                                      |
| ---------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `url`                  | Required                    | HTTP(S) MPD URL; redirects are followed by the browser                                       |
| `autoplay`             | `true`                      | Attempt playback after startup buffering; browser policy can block it                        |
| `startTime`            | VOD beginning / live target | Nonnegative presentation position in seconds                                                 |
| `quality`              | `'auto'`                    | Auto or a zero-based available quality index                                                 |
| `targetBuffer`         | `12`                        | Buffer target in seconds, accepted range 2–120; not a fixed latency                          |
| `audioLanguage`        | MPD main/default order      | Case-insensitive exact match to the MPD language string                                      |
| `liveRecoveryWindowMs` | `30000`                     | Live failure recovery budget, 1000–120000 ms; individual requests also time out              |
| `lowLatency`           | Enabled when signaled       | Set `false` to disable incremental Fetch CMAF appends                                        |
| `latencyControl`       | `false`                     | Opt in to playback-rate adjustment around the advertised target                              |
| `useMpdPatch`          | `true`                      | Use valid PatchLocation updates, otherwise reload the full MPD                               |
| `captionEncodings`     | Unicode BMP behavior        | Per-service CEA-708 P16 mapping, e.g. `{ 2: 'euc-kr' }`; shared decoder profile limits apply |
| `network`              | Fetch                       | Transport, timeout/retry/credential settings below                                           |
| `drm`                  | None                        | Application-configured EME key system and license integration                                |

`audioLanguage: 'en'` is not currently an ISO-639 alias lookup for `eng`. Get actual languages from `player.audioTracks`. Explicit track IDs come from the inventories, not display labels.

## Quality, audio and subtitles

```js
await player.selectQuality(-1); // Auto
await player.selectQuality(0); // index in player.qualityLevels
await player.selectAudioTrack(player.audioTracks[0].name);
player.selectSubtitleTrack(player.subtitleTracks[0].name);
player.selectSubtitleTrack(''); // Off
```

Check inventories before indexing. Listen for `qualitylevels`, `audiochange`, `subtitletracks` and `subtitlechange`; live MPD updates can change them. `selectedQuality` is the requested selection, while `currentQuality` identifies the quality at the playhead after queued media has drained. The UI shows Auto together with current resolution.

DASH text and CEA overlays are owned by the engine. Do not attach the MoQ bitmap `SubtitleRenderer` for these tracks. Text follows the playback Period and presentationTimeOffset. CEA-608/708 services appear when observed in clear video SEI; service numbers and configured P16 interpretation are retained. Encrypted video captions and separate DASH c608/c708 sample tracks are not currently decoded.

`player.isLive` follows MPD type. A dynamic-to-static transition updates the shared controls. Seeking uses `video.currentTime` within `video.seekable`; a live DVR overrun can trigger recovery to a playable live position.

## HTTP, redirects and authentication

```js
network: {
  transport: 'fetch', // or 'xhr'; XHR waits for complete CMAF responses
  timeoutMs: 15000,
  retries: 2,
  recoveryWindowMs: 30000,
  credentials: 'same-origin',
  headers: (url) => new URL(url).origin === 'https://media.example.com'
    ? { Authorization: `Bearer ${mediaToken}` }
    : {},
}
```

`mediaToken` is application-owned. The headers callback runs per requested resource and per explicitly selected mirror; limit it to intended origins. Browser redirect rules govern credentials on redirected requests. Use Fetch for `credentials: 'omit'`; XHR cannot guarantee omission of same-origin credentials and that combination is rejected.

The final redirected MPD URL is the base for relative resources. The player does not copy the MPD query string onto unrelated relative segment URLs: signed resources must be signaled correctly by the server. Media origins need CORS access for MPDs, segments, indexes, subtitles and UTC resources. Credentialed cross-origin requests need appropriate explicit-origin CORS responses. Byte-range delivery must expose valid Content-Range metadata.

BaseURL failover tries only MPD-declared alternatives after retryable failures, temporarily penalizes failed directories and preserves byte ranges. HTTP 401/403 is terminal. A mirror is not spliced into an already partially appended response. Steering servers, serviceLocation priority policies, explicit ETag/304 handling and CMCD/CMSD are separate pending features.

## DRM with EME

EME is the browser interface to its Content Decryption Module (CDM). ThePlayer keeps encrypted fMP4 samples encrypted through MSE; it does not implement a commercial DRM system or provide license entitlements.

```js
await player.load({
  protocol: 'dash',
  url: manifestUrl,
  drm: {
    keySystem: 'com.widevine.alpha',
    licenseTimeoutMs: 15000,
    license: async (message, messageType, signal) => {
      const response = await fetch(licenseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${licenseToken}`,
        },
        body: message,
        signal,
      });
      if (!response.ok) throw new Error(`License HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  },
});
```

`manifestUrl`, `licenseUrl` and `licenseToken` are provided by the application. This example assumes a binary license endpoint; adapt challenge wrapping, response unwrapping and authentication to the provider. Honor the abort signal. The media `network.headers` callback does not configure this application-owned license request. Do not log signed URLs, challenges, keys or tokens.

Optional `serverCertificate: Uint8Array`, `videoRobustness` and `audioRobustness` are forwarded to EME. Temporary sessions are closed during teardown; pending license callbacks are aborted. Persistent/offline licenses are not implemented. CENC/CBCS ClearKey and public Widevine are tested; passing a PlayReady or FairPlay key-system string is not proof of a working device/provider integration.

For synthetic ClearKey fixtures, use `keySystem: 'org.w3.clearkey'` and `clearKeys: { [hexKid]: hexKey }`, with 16-byte hexadecimal KIDs and keys. Keep fixture keys distinct from production secrets. MPD/in-band PSSH and initialization KIDs are handled by the shared EME controller; arbitrary in-Period sample-group key rotation remains unverified for DASH.

## Metadata and diagnostics

```js
player.addEventListener('metadata', ({ detail }) => {
  // Availability/append notification, not a playback-time callback.
  // Queue by detail.time if your application needs playback-time actions.
  metadataQueue.add(detail);
});
player.addEventListener('metadatawarning', ({ detail }) => {
  reportOptionalMetadataIssue(detail);
});
```

EventStream emits `type: 'dash-event'`, `scheme`, `value`, string `id`, presentation `time`, optional `duration`, string `data` and Period ID. In-band emsg uses the shared `type: 'emsg'`/`'id3'` payload, numeric ID and byte payload where applicable. The engine bounds and deduplicates notifications; it does not execute scripts or automatically insert ads. An application requiring cue enter/exit behavior must implement playback-time scheduling and seek policy.

`player.diagnostics` includes `buffer`, `quality`, `recovery`, `delivery`, `patches`, `lowLatency`, `metadataEvents`, `clockOffset` and `clockWarning`. Producer latency is `null` without a usable MPD reference; `producerType` distinguishes encoder/capture timing. A pending seek with decoded, buffered target data may be retried once after one second, shifting the target by 1 ms to release a browser seek stall; `recovery.seekRetries` counts these attempts. This does not bypass unavailable media or change paused state. A measured encoder-to-playback delay is not a capture-to-display measurement. MPD producer clocks currently require UTC date-time values; in-band prft is pending. Rate control respects advertised ServiceDescription bounds and yields to a manual playback-rate change.

Counters help troubleshoot playback; they are not a stable telemetry export schema or a promise of complete QoE accounting. Avoid publishing raw source configuration when sharing diagnostics.
