# Original HLS engine: experimental baseline

This engine is written for ThePlayer. No hls.js, Video.js/VHS or Shaka code is bundled. The initial implementation deliberately exposes a smaller, tested subset instead of claiming full compatibility with every HLS protocol version.

## Current coverage

| Area                             | Implementation                                                                                    | Validation                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Media and multivariant playlists | Original parser; compatible low-bandwidth startup; Auto ABR and manual quality selection          | Unit tests and browser playback                              |
| MPEG-TS                          | 188-byte packets, PAT/PMT, PES, AVC/H.264, HEVC/H.265 and ADTS AAC-LC / declared HE-AAC v1 → fMP4 | Original synthetic fixtures; independent FFmpeg decode check |
| Fragmented MP4                   | EXT-X-MAP, AVC/HEVC/AAC initialization, fragment timing and MSE appends                           | Browser playback and seeking                                 |
| Live                             | Sliding playlist refresh, sequence alignment, hold-back and LIVE indicator                        | Local moving-window server                                   |
| VOD                              | ENDLIST, finite duration, timeline, seek and playback completion                                  | Browser seek tests                                           |
| EVENT → ended                    | Playlist updates can remove live status on ENDLIST                                                | Local dynamic fixture                                        |
| Requests                         | Fetch or XHR, abort, timeouts, bounded retry, relative URLs and redirects                         | Browser Fetch/XHR; injected HTTP 503; teardown tests         |
| Byte ranges                      | Explicit and implicit segment offsets; initialization ranges                                      | Unit tests and HTTP range fixture                            |
| AES-128                          | Identity keys, explicit or sequence IV, Web Crypto AES-CBC                                        | FFmpeg-encrypted TS fixture                                  |
| Discontinuities                  | Media timestamps rebased at a discontinuity                                                       | Reset-timestamp TS fixture                                   |
| WebVTT                           | Subtitle rendition selection, timestamp map, basic cue placement, Off                             | Parser and browser text-track tests                          |
| Variables                        | NAME/VALUE, IMPORT and QUERYPARAM parsing                                                         | Parser coverage; not an exhaustive conformance suite         |

## Explicit limits

- **No full protocol-version claim.** The parser recognizes version numbers through 13 and rejects higher versions. Acceptance of a version number does not certify all its optional features.
- **LL-HLS is not implemented yet.** A playlist with complete segments can play using ordinary reloads. Partial-only playlists, blocking reload, delta merging, preload hints and rendition reports are not implemented. Delta playlists are rejected.
- **Auto ABR and manual switching** support browser-compatible AVC/HEVC/AAC-LC/HE-AAC v1 variants in the same audio/subtitle groups. Switching takes effect at a future segment boundary.
- External AAC audio renditions have independent SourceBuffers and language selection. Audio and video must share a media clock; live playlists need matching sequence/discontinuity positions or PROGRAM-DATE-TIME anchors. Arbitrary timeline repair is not supported.
- **No TTML/IMSC1, stpp, wvtt-in-MP4 or HLS CEA-608/708 rendering yet.** Existing CEA-708/P16 support belongs to the MoQ pipeline and does not automatically apply to HLS. WebVTT STYLE/REGION blocks and some cue settings are not rendered by this baseline.
- TS assumes independently decodable segments, one video/audio stream, one AVC/HEVC access unit per PES and a PSI section fitting in one packet. Multi-packet PSI, unusual PES boundaries, non-random-access segment starts and unsupported codecs fail explicitly. More broadcast edge-case testing is needed.
- AVC, HEVC Main/Main10 and AAC-LC/declared HE-AAC v1 are supported. HEVC needs a browser/OS decoder exposed through MSE; unsupported variants are filtered before ABR. Multilayer HEVC, Dolby Vision and HDR display/tone mapping are not validated. AV1, Dolby audio, packed audio, I-frame-only trick-play and image playlists are not supported.
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

## Audio and quality selection

`player.audioTracks` and `player.qualityLevels` expose available choices. Call `selectAudioTrack(track.name)` or `selectQuality(level.id)`. The controls offer compact audio and HD menus. Switching preserves the media element, playback timeline and paused state; it is not instantaneous because the current segment finishes first.

The deterministic rendition fixture uses two resolutions, two independently decoded audio tones and a deliberately shifted video timestamp epoch. Browser assertions check decoded audio frequency, rendered resolution and pause preservation through switches.

## Public test streams

The demo includes presets from [Apple streaming examples](https://developer.apple.com/streaming/examples/) and [Mux test streams](https://test-streams.mux.dev/). Media is fetched directly from its publisher and is not redistributed.

Run `npm run test:hls:public` after building for optional network-dependent playback checks. `HLS_PUBLIC_SOURCE=apple-bipbop` or `mux-bbb` selects one source. The checks cover rendered frames, progress after a quality switch, bounded buffering and available subtitle selection. They are separate from CI because remote availability and CORS can change. Results are written to ignored `test-results/hls-public.json`. A passing stream is evidence for that stream and browser, not HLS conformance certification.

## Automatic quality and rendition selection

Quality defaults to Auto. An original throughput estimator uses fast/slow averages and a 25% safety margin. Upgrades require buffer headroom and an eight-second cooldown; downgrades do not wait for that cooldown. Manual selection disables adaptation until Auto is selected again. `selectQuality(-1)` enables Auto; `autoQuality`, `selectedQuality` (scheduled) and `currentQuality` (presentation timeline) expose the distinction. The menu and MediaInfo display the current quality, not a future buffered switch.

This is a conservative first ABR policy. It does not yet abandon in-flight slow requests, use viewport constraints or adapt across different audio/subtitle groups. A switch needs enough lead time to fetch its first segment. The browser test throttles actual segment responses, verifies automatic upgrades/downgrades and checks manual locking.

`DEFAULT`, `AUTOSELECT` and `FORCED` follow [RFC 8216 §4.3.4.1](https://www.rfc-editor.org/rfc/rfc8216.html#section-4.3.4.1). Missing booleans are NO. DEFAULT=YES with an explicitly supplied AUTOSELECT=NO, duplicate names/defaults in a group and FORCED on non-subtitle renditions are rejected. A default rendition is selected without an explicit user override. Otherwise AUTOSELECT allows language matching; manual-only renditions remain available for explicit selection.

Source options `audioLanguage` and `subtitleLanguage` supply explicit preferences; `subtitleLanguage: 'off'` suppresses automatic captions. `preferredLanguages` overrides the browser language list. Non-default, non-forced subtitles need an explicit selection. Forced subtitle matching considers the selected audio language. User subtitle selection/Off persists through quality and audio switches. Accessibility characteristics and associated language are parsed and exposed, but no OS accessibility preference is inferred.

HE-AAC v1 MPEG-TS uses the declared `mp4a.40.5` profile to signal SBR and its doubled output rate correctly. HE-AAC v2/PS and detecting undeclared SBR in raw ADTS remain unsupported. The Mux test checks all five advertised AVC profiles, including transitions between AAC-LC and HE-AAC, with ongoing video and audio decoding.

## Mux catalog audit — 2026-11-17

All eight entries on [Mux's test-stream index](https://test-streams.mux.dev/) were checked in Chromium using ThePlayer's own HLS engine. The check observes rendered frames and continued playback; it exercises a quality transition where available and seeks across the first ad discontinuity for the ad-insertion fixture. This is a bounded smoke test, not validation of an entire asset, every rendition or every ad transition. The dedicated Big Buck Bunny public test separately exercises all five qualities.

| Publisher fixture            | Observed result | Scope / limitation                                                                               |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| Big Buck Bunny — adaptive    | Passed          | Playback and quality transition; five profiles available                                         |
| Big Buck Bunny — 480p        | Passed          | Direct media playlist                                                                            |
| ARTE China                   | Passed          | Playback and quality transition; six profiles available                                          |
| Ad insertion in EVENT stream | Passed          | AES-128 and first ad discontinuity; the hosted snapshot is ended                                 |
| Issue 666                    | Passed          | MPEG-TS byte ranges                                                                              |
| DK Turntable                 | Passed          | Transition between variants with shifted timestamps                                              |
| SAMPLE-AES                   | Unsupported     | Explicit encryption rejection; AES-128 support does not imply SAMPLE-AES support                 |
| Tears of Steel with IMSC     | Unsupported     | `stpp.ttml.im1t` in CODECS currently excludes the variant; no claim of video or caption playback |

The six passing Mux sources are available in the demo presets alongside Apple's example. Run `npm run test:hls:mux` to repeat the catalog audit; `HLS_PUBLIC_SOURCE=mux-imsc` can select one case. Results go to ignored `test-results/mux-audit.json`. Known unsupported cases are recorded as **unsupported**, never passed; unexpected failures make the command exit nonzero. Public availability, contents and CORS can change, so this audit is separate from deterministic CI. Media stays hosted by Mux and is not redistributed.

## Unified Streaming legacy AVC example

The demo includes the Unified Streaming Tears of Steel `.mp4/.m3u8` master. Its AVC entries use decimal profile/level aliases such as `avc1.66.30`, `avc1.77.31` and `avc1.100.40`; these are normalized for variant filtering. The actual decoder configuration still comes from the media SPS/avcC, not synthesized playlist flags. Apple's [archived HLS codec guidance](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/StreamingMediaGuide/FrequentlyAskedQuestions/FrequentlyAskedQuestions.html) documents the older spelling.

The master advertises five AVC video variants, three HEVC video variants and two audio-only variants. Video mode includes browser-supported AVC and HEVC profiles; audio-only profiles have a separate ladder. On a browser without HEVC, five AVC profiles remain. A video presentation with no supported video variant fails explicitly; audio mode can be requested separately. This master does not advertise subtitle renditions. Run `HLS_PUBLIC_SOURCE=unified-tos npm run test:hls:public` for playback and transitions through all five AVC qualities.

## HEVC and audio-only (0.5.0-alpha.1)

The TS demuxer reads stream type `0x24`, VPS/SPS/PPS, picture dimensions and profile/tier/level. It writes a four-byte-length-prefixed `hvc1` sample entry and `hvcC` decoder configuration, preserving composition offsets for reordered pictures. Existing fMP4 `hvc1` and `hev1` configurations pass through without transcoding. Original synthetic Main and Main10 fixtures each decode 200 frames and AAC audio using independent FFmpeg, and the first real Unified Streaming HEVC segment also decodes after our remux. The headless test Chromium has no HEVC decoder: its explicit capability rejection is tested, **not counted as HEVC playback**. Visual playback on HEVC-capable browser/OS combinations remains a device-validation requirement.

Standalone AAC works in TS and fMP4, directly or through a multivariant audio-only playlist. Auto ABR, manual bitrate selection, seek, pause and live refresh use the same scheduler. In a mixed master, the Quality menu offers **Audio only** / **Video**. Changing media mode creates a new MSE session because the track count changes; VOD position and pause state are retained, while live mode rejoins the current live window. This transition can have a short interruption. Switching also fills any uncovered interval in the old lane before the new boundary, including audio ladders with different segment durations. Audio mode does not download the video renditions. It requires a standalone audio variant in the master; it does not extract audio from video variants.

```js
await player.load({ protocol: 'hls', url: masterUrl, media: 'audio' });
// With a mixed master already loaded:
await player.selectMediaMode('video');
```

The embed also accepts `&media=audio`. MP3, AC-3/E-AC-3 and packed ADTS/ID3 audio are not implemented in this release.

## Apple AV1 sample audit

The [Apple AV1 sample](https://devstreaming-cdn.apple.com/videos/streaming/examples/av1-sample/av1-sample.m3u8) advertises 10-bit AV1 (`av01`), several audio groups (AAC-LC, HE-AAC v1/v2, AC-3 and E-AC-3), description audio, and multilingual WebVTT renditions. This release explicitly rejects the AV1 variants; it does not claim playback of this sample. AV1 needs its own `av1C` initialization handling, codec metadata normalization, capability filtering and real playback tests. HEVC support does not add AV1 automatically.

The live Unified Streaming audio-only URL was checked separately: the 64 kb/s variant decoded audio in Chromium. A later 128 kb/s switch encountered upstream HTTP 503 responses without CORS headers, surfaced by the browser as a fetch failure. Local 64/128 kb/s switching, including a two-second buffer switching to four-second segments, is covered by deterministic tests; this network failure is not reported as a successful public switch.
