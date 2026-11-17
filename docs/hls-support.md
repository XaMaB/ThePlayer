# Original HLS engine: experimental baseline

This engine is written for ThePlayer. No hls.js, Video.js/VHS or Shaka code is bundled. The initial implementation deliberately exposes a smaller, tested subset instead of claiming full compatibility with every HLS protocol version.

## Current coverage

| Area                             | Implementation                                                             | Validation                                                   |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Media and multivariant playlists | Original parser; a compatible low-bandwidth variant is selected once       | Unit tests and browser playback                              |
| MPEG-TS                          | 188-byte packets, PAT/PMT, PES, AVC/H.264 and ADTS AAC-LC → fMP4           | Original synthetic fixtures; independent FFmpeg decode check |
| Fragmented MP4                   | EXT-X-MAP, AVC/AAC initialization, fragment timing and MSE appends         | Browser playback and seeking                                 |
| Live                             | Sliding playlist refresh, sequence alignment, hold-back and LIVE indicator | Local moving-window server                                   |
| VOD                              | ENDLIST, finite duration, timeline, seek and playback completion           | Browser seek tests                                           |
| EVENT → ended                    | Playlist updates can remove live status on ENDLIST                         | Local dynamic fixture                                        |
| Requests                         | Fetch or XHR, abort, timeouts, bounded retry, relative URLs and redirects  | Browser Fetch/XHR; injected HTTP 503; teardown tests         |
| Byte ranges                      | Explicit and implicit segment offsets; initialization ranges               | Unit tests and HTTP range fixture                            |
| AES-128                          | Identity keys, explicit or sequence IV, Web Crypto AES-CBC                 | FFmpeg-encrypted TS fixture                                  |
| Discontinuities                  | Media timestamps rebased at a discontinuity                                | Reset-timestamp TS fixture                                   |
| WebVTT                           | Subtitle rendition selection, timestamp map, basic cue placement, Off      | Parser and browser text-track tests                          |
| Variables                        | NAME/VALUE, IMPORT and QUERYPARAM parsing                                  | Parser coverage; not an exhaustive conformance suite         |

## Explicit limits

- **No full protocol-version claim.** The parser recognizes version numbers through 13 and rejects higher versions. Acceptance of a version number does not certify all its optional features.
- **LL-HLS is not implemented yet.** A playlist with complete segments can play using ordinary reloads. Partial-only playlists, blocking reload, delta merging, preload hints and rendition reports are not implemented. Delta playlists are rejected.
- **No ABR or manual quality switching yet.** A compatible rendition is chosen at startup. Alternate audio playlists are not supported; use muxed audio/video or a standalone media playlist.
- **No TTML/IMSC1, stpp, wvtt-in-MP4 or HLS CEA-608/708 rendering yet.** Existing CEA-708/P16 support belongs to the MoQ pipeline and does not automatically apply to HLS. WebVTT STYLE/REGION blocks and some cue settings are not rendered by this baseline.
- TS assumes independently decodable segments, one video/audio stream, one AVC access unit per PES and a PSI section fitting in one packet. Multi-packet PSI, unusual PES boundaries, non-IDR segment starts and unsupported codecs fail explicitly. More broadcast edge-case testing is needed.
- AVC/AAC is the current codec baseline. HEVC, AV1, Dolby codecs, packed audio, I-frame-only trick-play and image playlists are not supported.
- SAMPLE-AES, DRM/EME, session-key preloading, content steering, interstitials and timed metadata are not implemented.
- GAP recovery and live resets without a shared sequence/timeline are not implemented. These require reconnecting.
- The network client bounds individual resources at 64 MiB. No server proxy is provided; cross-origin resources need appropriate CORS headers.
- The player uses MSE. There is no native-HLS fallback in this engine; such a fallback would not test our own parser/pipeline.

## Usage

```js
const player = new ThePlayer(video);
await player.load({
  protocol: 'hls',
  url: 'https://media.example.com/master.m3u8',
  network: {
    transport: 'fetch', // or 'xhr'
    timeoutMs: 15000,
    retries: 2,
  },
  targetBuffer: 12,
});
```

Use `network.headers(url)` to add request headers only to intended resource origins. Fetch supports the standard credentials modes; use Fetch when cookies must be omitted even for same-origin requests. XHR cannot provide that omission guarantee.

`player.isLive` and `streamchange` describe the current presentation. `seekToLive()` follows the engine's hold-back. For VOD, use the video element's `currentTime`/`duration`. HLS text cues are displayed through browser TextTracks; no canvas renderer is required for them.

The demo accepts `embed.html?src=<encoded-playlist-url>&transport=fetch`. MoQ's relay/namespace parameters continue to work. HLS is loaded as a separate module; deploy the entire `dist` directory, including `chunks`.

## Reproducible tests

Requirements: FFmpeg with libx264, and Playwright Chromium.

```sh
npx playwright install chromium
node scripts/prepare-hls-fixtures.mjs
npm run build
node tests/hls-browser.mjs
```

Fixtures are generated in the OS temporary directory. `THEPLAYER_HLS_FIXTURES` selects another directory. Test media contains generated pictures and tones, not recorded broadcast content. Unit tests run as part of `npm test` and do not require FFmpeg or a browser.
