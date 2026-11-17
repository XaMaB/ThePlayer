# Original HLS engine: experimental baseline

This engine is written for ThePlayer. No hls.js, Video.js/VHS or Shaka code is bundled. The initial implementation deliberately exposes a smaller, tested subset instead of claiming full compatibility with every HLS protocol version.

## Current coverage

| Area                             | Implementation                                                                                    | Validation                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Media and multivariant playlists | Original parser; compatible low-bandwidth startup; Auto ABR and manual quality selection          | Unit tests and browser playback                              |
| MPEG-TS                          | 188-byte packets, PAT/PMT, PES, AVC/H.264, HEVC/H.265 and ADTS AAC-LC / declared HE-AAC v1 → fMP4 | Original synthetic fixtures; independent FFmpeg decode check |
| Fragmented MP4                   | EXT-X-MAP, AVC/HEVC/AV1/AAC initialization, fragment timing and MSE appends                       | Browser playback and seeking                                 |
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
- **LL-HLS fMP4 baseline is implemented.** Partial-only startup, dependent parts, parent completion, blocking reload, delta merge/full reload fallback and speculative whole-resource/bounded-range preload hints are supported. Rendition-report positions are used when available. Open-ended hinted ranges and MAP hints are supported; Fetch can consume confirmed ranges from a growing response, while XHR falls back to a bounded request when the hinted response has not completed. See the validation scope below.
- **Auto ABR and manual switching** support browser-compatible AVC/HEVC/AV1/AAC-LC/HE-AAC v1 variants in the same audio/subtitle groups. Switching takes effect at a future segment boundary.
- External AAC audio renditions have independent SourceBuffers and language selection. Audio and video must share a media clock; live playlists need matching sequence/discontinuity positions or PROGRAM-DATE-TIME anchors. Arbitrary timeline repair is not supported.
- **TTML/IMSC text and MP4 WebVTT are implemented subsets.** See the text-profile scope below. HLS CEA-708 SEI decoding uses an original implementation separate from the MoQ decoder; see its scope below.
- TS supports one video/audio stream, supported access-unit timing and complete PES packets. Multi-packet PAT/PMT sections are assembled and CRC-checked. Annex-B NAL units may span PES boundaries, and multiple pictures per PES are supported for the timing profiles below. IDR and immediate AVC intra recovery points are marked as random access; other segment starts preserve continuity and MSE waits for a random access point when required. Unsupported codecs still fail explicitly. More broadcast edge-case testing is needed.
- AVC, HEVC Main/Main10, AV1 Main 8/10-bit (fMP4) and AAC-LC/declared HE-AAC v1 are supported. HEVC needs a browser/OS decoder exposed through MSE; unsupported variants are filtered before ABR. Multilayer HEVC, Dolby Vision and HDR display/tone mapping are not validated. Packed AAC/MP3 and AC-3 are supported as described below. I-frame-only trick-play and image playlists remain pending.
- SAMPLE-AES supports TS AVC/AAC/AC-3 and packed AAC/AC-3 identity keys. fMP4 cenc/cbcs uses EME, with ClearKey validated. Content steering and interstitials remain pending; ID3/emsg metadata delivery is described below.
- Declared GAP segments have bounded scheduling/playback recovery; see the validation scope below. Live-window loss and detected timeline resets now trigger a bounded coordinated media restart; see below.
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

| Publisher fixture            | Observed result                    | Scope / limitation                                                                                                           |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Big Buck Bunny — adaptive    | Passed                             | Playback and quality transition; five profiles available                                                                     |
| Big Buck Bunny — 480p        | Passed                             | Direct media playlist                                                                                                        |
| ARTE China                   | Passed                             | Playback and quality transition; six profiles available                                                                      |
| Ad insertion in EVENT stream | Passed                             | AES-128 and first ad discontinuity; the hosted snapshot is ended                                                             |
| Issue 666                    | Passed                             | MPEG-TS byte ranges                                                                                                          |
| DK Turntable                 | Passed                             | Transition between variants with shifted timestamps                                                                          |
| SAMPLE-AES                   | Public fixture failed (2026-11-17) | Hosted segment contains UTF-8 replacement bytes; invalid TS also rejected by FFprobe. Generated TS SAMPLE-AES fixtures pass. |
| Tears of Steel with IMSC     | Video playback passed (2026-11-17) | 349 rendered frames and continued audio/video playback; this public smoke test does not inspect displayed subtitle text.     |

The original six passing Mux sources are available in the demo presets alongside Apple's example. Run `npm run test:hls:mux` to repeat the catalog audit; `HLS_PUBLIC_SOURCE=mux-imsc` can select one case. Results go to ignored `test-results/mux-audit.json`. Known unsupported cases are recorded as **unsupported**, never passed; unexpected failures make the command exit nonzero. Public availability, contents and CORS can change, so this audit is separate from deterministic CI. Media stays hosted by Mux and is not redistributed.

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

The [Apple AV1 sample](https://devstreaming-cdn.apple.com/videos/streaming/examples/av1-sample/av1-sample.m3u8) advertises 10-bit AV1 (`av01`), several audio groups (AAC-LC, HE-AAC v1/v2, AC-3 and E-AC-3), description audio, and multilingual WebVTT renditions. Version 0.6.0-alpha.1 adds AV1 fMP4 playback and this source as an optional demo preset/test. The compatible audio/subtitle group is retained through quality switches; unsupported HE-AAC v2 and Dolby combinations remain excluded. The public test passed on 2026-11-17 with 927 rendered frames, decoded audio, 13 available video qualities, a quality transition, seek to 60 seconds, English → English DVS audio switching and active English WebVTT cues. This validates the tested transitions, not every quality/device combination. Run `HLS_PUBLIC_SOURCE=apple-av1 npm run test:hls:public`.

The live Unified Streaming audio-only URL was checked separately: the 64 kb/s variant decoded audio in Chromium. A later 128 kb/s switch encountered upstream HTTP 503 responses without CORS headers, surfaced by the browser as a fetch failure. Local 64/128 kb/s switching, including a two-second buffer switching to four-second segments, is covered by deterministic tests; this network failure is not reported as a successful public switch.

## AV1 fMP4 (0.6.0-alpha.1)

Implemented against [AOM AV1 ISOBMFF v1.3.0](https://aomediacodec.github.io/av1-isobmff/v1.3.0.html), particularly the `av01` sample entry, `av1C` decoder record and codec parameter syntax. The engine reads profile/level/tier, bit depth, monochrome/chroma and optional `nclx` color information, checks reserved/header fields and normalizes codec tier casing. Invalid configurations fail explicitly. Codec strings preserve the optional color fields as a complete group. Browser capability checks apply before ABR and again to the actual initialization.

Initialization and media bytes pass unchanged to MSE, retaining config OBUs, color/HDR boxes, sample groups and fragment timestamps. The browser supplies the AV1 decoder. This is container/playback integration, not a new software AV1 decoder or an exhaustive AV1 bitstream validator. Sequence-header/OBU decoding and decoder-model behavior belong to the browser. Without an `nclx` box, the MIME capability query uses the mandatory codec fields; the original bitstream/color metadata still reaches the decoder.

Synthetic AV1 Main 8-bit and 10-bit fMP4 fixtures verify actual Chromium frames and AAC decoding, Fetch/XHR, bit-depth/resolution transitions and seeking. Browser/OS support is required; Profile 1/2, 12-bit, scalable/multilayer streams, HDR display accuracy and specialized forward-keyframe recovery are not device-validated. AV1 MPEG-TS, WebM, raw OBU input and encrypted AV1 are outside this release's scope.

## Ancillary caption tracks (0.6.0-alpha.2)

Apple's [closed-caption sample description](https://developer.apple.com/documentation/quicktime-file-format/closed_captioning_sample_description) identifies `c608` and `c708` as caption sample formats. Some fMP4 sources include `clcp` handler tracks with `c608` or `c708` sample entries alongside video. These must not be classified as audio or passed as unsupported codecs to MSE. The engine marks their `trak`, matching `trex`, and `traf` descriptors as same-sized `free` boxes. Caption-only `moof` boxes become `free` as well. All media payloads and byte positions remain unchanged, preserving fragment offsets and A/V timing. Unknown and encrypted sample entries still fail explicitly.

In 0.6.0-alpha.2 this was caption-track exclusion only. Since 0.7.0-alpha.1, `c608` is decoded before exclusion from MSE, as described below; `c708` remained excluded until 0.16.0-alpha.1, which adds original CDP extraction. Unsupported formats appear in `player.diagnostics.unsupportedCaptions`. External WebVTT renditions remain selectable.

The [Apple Dolby Vision/Atmos sample](https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/main.m3u8) passed a browser test on 2026-11-17 with 810 rendered frames, decoded audio, a quality change, seek and active English WebVTT cues. The tested path uses compatible AVC/AAC renditions (two qualities in the selected audio group). This is not a claim of Dolby Vision or Atmos support. Run `HLS_PUBLIC_SOURCE=apple-dv-atmos npm run test:hls:public`. A synthetic caption-track fixture and byte-offset unit checks guard the regression in CI.

## CEA-608 captions (0.7.0-alpha.1)

An original decoder extracts `cdat`/`cdt2` pairs from one fMP4 `c608` track and exposes CC1–CC4 in the CC menu. Master CLOSED-CAPTIONS metadata supplies labels, language, DEFAULT/AUTOSELECT and INSTREAM-ID. Timing follows sample presentation timestamps and video-frame cadence, including signed composition offsets, byte ranges and fragment defaults. Caption decoding errors are diagnostic warnings rather than fatal A/V errors.

Implemented: odd-parity checking, repeated-control suppression, pop-on/paint-on/2–4-row roll-up, displayed/non-displayed memories, PAC row/indent, tab, backspace, erase commands, carriage return, basic/special/extended characters, foreground colors, italic and underline. A 32-column × 15-row safe-area layout is mapped to native WebVTT cues with left alignment. Browser typography controls the final glyph dimensions; this is not a pixel-exact broadcast renderer.

Caption history is checkpointed around playback. Quality transitions replace future caption state; seeks outside buffered media replay up to three preceding segments to recover caption memory. Cues end at the decoded horizon so stale preroll text cannot appear beyond known data. A live join or a seek without enough caption history can wait for the next complete caption update.

Since 0.14.0-alpha.1, ATSC registered T.35 data in AVC/HEVC SEI is also extracted from TS and fMP4. Independent field decoders preserve CC1/CC2 and CC3/CC4; XDS data is skipped. Generated AVC fixtures are recognized by FFmpeg and tested for selection/seek in Chromium with Fetch/XHR. HEVC SEI has unit coverage; full HEVC-caption playback is not yet validated.

Limits: standalone SCC, multiple `c608` tracks, Text/XDS services, background attributes and flashing are not implemented. This is a tested subset, not a full CTA-608 conformance claim. Existing MoQ CEA-708/P16 support is independent.

Unit tests cover decoding, row/column commands, parity, character replacement, fragment bounds/timestamps and timeline replacement/checkpoints. The original synthetic caption fixture exercises selection, positioning, seek and Off in Chromium. The optional Apple Dolby sample test verifies actual English CC1 text, seek, quality switching and subsequent WebVTT selection through compatible AVC/AAC variants. `player.diagnostics.captions608` exposes packet, parity, retained-event and warning diagnostics.

## Network recovery and declared gaps (0.8.0-alpha.1)

Fetch and XHR classify temporary transport failures, timeouts, HTTP 404/408/425/429 and 5xx responses as retryable. Authentication/authorization failures and invalid media/range responses fail explicitly. After the short retry count, requests can continue within `network.recoveryWindowMs` (default 30000 ms total per resource), with bounded backoff and request timeouts clipped to the budget. Set the window to 0 to use only `network.retries`. A persistent 404 eventually fails; it is not silently treated as a playable segment or an implicit gap. Resource cancellation interrupts both requests and retry waits.

`diagnostics.recovery` reports active extended recoveries, extended attempts, recovered requests, exhausted budgets and the last transient error. Recovery counters describe network requests, not decoded frames. HLS resources are retried without recreating the player. Live-window movement during long outages, stale playlists and encoder timeline resets remain separate work.

Playlist-declared `EXT-X-GAP` segments are not requested. The scheduler advances past them, and the playback clock crosses a declared gap only when playable buffered media exists after it. Adjacent declared gaps are combined. Unknown missing content is not skipped. The first validation covers multiplexed A/V VOD with adjacent gaps; all-gap startup and complex external-audio/discontinuity combinations are not certified.

Run `npm run test:hls:recovery` for deterministic Fetch/XHR faults: temporary 503, disconnected sockets, request timeout, playlist reload failures, persistent missing segment, forbidden source, cancellation during recovery and declared gaps. The same suite accepts `HLS_RECOVERY_BASE=http://test-host:9088` for external transport tests. To serve generated TS fixtures and built player assets, run `HOST=0.0.0.0 PORT=9088 npm run serve:hls:tests`; defaults bind localhost. The test server has fixed fault scenarios and no HTTP administration API. Use only generated media and public build artifacts in its roots.

## Live presentation recovery (0.9.0-alpha.1)

Successful HTTP responses are tracked separately from media progress. Unchanged live tails become stale after `liveStallTimeoutMs` (default at least 30 seconds or three target durations). If the publisher resumes, the stale diagnostic clears. `liveRecoveryTimeoutMs` bounds an indefinitely frozen publisher (default at least 120 seconds). Both options are milliseconds and must be at least 1000; the recovery deadline cannot precede the stale threshold.

Backward sequence resets, changed segment identity and loss of the live window rebuild the media presentation with fresh main/audio playlists, new MediaSource buffers, cleared timestamp/key/caption state and a fresh live starting point. Audio/video are aligned before releasing the old presentation. Paused state and selected quality/audio are retained; live playback position moves to the new window. Three restarts per minute bound pathological sources. `diagnostics.live` exposes stale state per media lane and restart counts/reasons. This is explicit presentation recovery, not guessed continuity across unrelated timelines.

External audio normally retains the shared media clock. When that clock would place a freshly aligned audio rendition more than a target duration away from its playlist position, the lane establishes its own timestamp offset from the already aligned playlist. `audioClockRebases` records this correction; PDT or compatible media sequences are still required for meaningful rendition alignment.

Tests cover frozen/resuming and frozen/terminal playlists, sequence reset, missed live window, paused restart and separate audio after an ABR change. A restarted publisher that reuses exactly the same sequence, URI, timing and metadata without any observable change cannot be detected from its playlist alone.

PAT/PMT parsing additionally supports pointer-field tails, sections spanning TS packets, several sections in a payload and complete versioned tables. CRC errors and truncated descriptors fail explicitly. A generated multi-packet PMT fixture is decoded independently with FFmpeg and exercised in browser playback.

`npm run test:hls:soak` exercises a continuously sliding synthetic live window with repeated media timestamp resets and declared discontinuities. It checks clock advancement, errors and buffer bounds, and records frames, dropped frames and JS heap samples in `test-results/hls-soak.json`. CI runs a 60-second smoke test; `HLS_SOAK_SECONDS` selects a longer run. A short CI run is not a claim of multi-day device stability.

## AVC/HEVC access-unit assembly (0.10.0-alpha.1)

PES packets and coded pictures are no longer treated as interchangeable. Annex-B data is assembled across PES payloads, including start codes and NAL units split between packets. Continuation PES packets may omit timestamps. AVC picture boundaries use SPS/PPS and slice-header identity, including frame number, field flags, reference status, IDR id and POC; AUD is optional. HEVC uses first-slice flags and SPS/PPS POC metadata.

Explicit PTS/DTS anchors remain authoritative. For multiple pictures under one PES anchor, constant cadence comes from AVC VUI or neighboring PES decode timestamps; progressive POC type 0 reconstructs reordered presentation timestamps, including POC wrap. Generated AVC, AVC B-frame and HEVC Main/Main10 streams are repacketized into split PES and groups of 2 or 20 pictures with AUD removed. Every output video PTS/DTS and decoded frame hash is compared with the original using independent FFmpeg tools.

This does not certify every elementary-stream timing mode. Untimestamped field/IDR transitions, inferred reordered AVC POC type 1, ambiguous cadence and variable-rate groups without sufficient timing information are rejected. AVC MMCO5 order resets inside untimestamped groups are not validated. Segments still require complete PES packets and independent video startup; mid-segment parameter-set changes are rejected rather than writing an inconsistent sample description. Scalable/multiview AVC and multilayer HEVC are outside the supported profile.

## Emergency adaptation and quarantine

In Auto mode, in-flight main-rendition requests report transferred bytes and elapsed time. When projected completion threatens the available buffer and a lower rendition is cheaper to retrieve, the engine cancels that request and loads the corresponding lower-quality segment. A failed rendition is excluded for 30 seconds, with repeated failures extending the interval up to 180 seconds. Manual quality selection clears that rendition's quarantine and retains the user's choice.

Resource cancellation does not abort the session or independent audio. Playlist/init validation and layout checks still apply to fallback candidates. Exhausting all lower compatible candidates reports the error; this is recovery policy, not a guarantee against stalls on links below the lowest bitrate. Diagnostics expose aborts, failovers and quarantined levels. Fetch/XHR browser tests cover delayed first bytes, throttled bodies and HTTP 503.

## Low-latency delivery

The playlist loader follows advertised blocking and delta capabilities, preserves application query parameters, and strips delivery directives from persistent playlist identity. Missing delta history triggers a full reload; rejected or timed-out blocking requests temporarily fall back to polling. Cached parent state retains encryption/map/discontinuity and byte-range information.

The media scheduler represents a parent once, using its parts when available. It starts/seeks from independent parts, retains dependent pictures, and uses PART-HOLD-BACK for live positioning. Preload bytes remain speculative until a published PART matches them. Superseded hints are cancelled; the cache is bounded and session cancellation reaches its requests. The default fallback behavior remains available for ordinary HLS.

Deterministic Fetch/XHR browser tests cover blocking delivery, delta recovery, rejected directives, timeouts, 500 ms fMP4 parts with dependent AVC pictures, partial-only startup, timestamp discontinuities, duplicate-request prevention and abandoned preload hints. Rendition-report URI/position selection has unit coverage. This is not a claim of validation across every CDN, encrypted partial-segment format, independent-audio LL stream or browser/device. Browser networking controls HTTP/2 and HTTP/3 negotiation and priority behavior.

A 30-minute ordinary live test on the 0.9 recovery implementation completed 360 samples with no player errors or reported dropped frames. Observed buffer range was 2.22–5.98 s with a 4 s target; maximum sampled JavaScript heap was 13.1 MB. This synthetic Chromium result is not a device-certification or a multi-day stability claim.

## TTML/IMSC and fragmented text (0.13)

Original `stpp` and `wvtt` sample extraction uses fragment timestamps, duration/default-size tables and media-data bounds. IMSC text uses a separate DOM overlay with positioned regions, origin/extent, display/text alignment, inherited font/color styles, timed spans, line breaks, percentage/pixel/cell sizing, vertical writing direction and safe text insertion. Media clock/frame/tick expressions and parent timing are parsed; each document is clipped to its MP4 sample interval. Whole-resource AES-128 encryption is supported for text media and initialization with an explicit IV. Raw TTML XML is also accepted as a convenience; Apple's HLS IMSC carriage is fMP4.

This is not full TTML2/IMSC presentation conformance: ruby, timed `set` animations, image profiles and some advanced typography are not implemented. The HLS authoring text profile does not require IMSC image tracks. These limits remain part of the active subtitle work.

WebVTT now accepts safe, scoped cue STYLE rules, region definitions and explicit line/position alignment. Native VTTRegion is used where exposed; otherwise region anchors/width map to native cue placement. The fallback does not implement region scrolling/line-count clipping. Timestamp maps unwrap the 33-bit clock near the playback timeline, and repeated segmented cues are deduplicated.

Browser checks exercise XML rejection, frame/tick timing, style inheritance, layout geometry, timed-span transitions, seeking, switching between stpp/wvtt, Off/teardown and AES-128 text through Fetch and XHR. FFprobe independently recognizes the generated stpp track as TTML with the expected sample timestamp/time base. The Amsterdam encrypted-text checks use a separate HTTPS test endpoint because remote HTTP does not expose Web Crypto.

## CEA-708 SEI services (0.15.0-alpha.1)

Original DTVCC packet assembly handles sequence loss, standard/extended services and commands across service blocks. Each service has eight independent windows, pen state, media-time delay/cancel/reset processing and checkpointed history for seeking and rendition replacement. The DOM renderer preserves window anchors, relative/absolute coordinates, rows/columns, priority, left/right/center justification, horizontal/vertical print and scroll direction, word wrapping, foreground/background colors and opacity, italic/underline, pen size/font and basic edges/borders. Unknown extended commands are skipped by their defined length; unknown graphics use the specified fallback.

P16 with a zero high byte uses G0/G1 characters. Nonzero P16 defaults to Unicode BMP, replacing surrogate/noncharacter values. Broadcasters using legacy regional encodings can set `captionEncodings: { 1: 'euc-kr' }` on the HLS source; `unicode`, `gbk` and `big5` are also accepted. Encoding is an explicit per-service choice rather than inferred from language. G3 graphics use underscore substitution.

Fetch/XHR browser fixtures verify AVC TS/fMP4 text, two services, left alignment/column geometry, P16, seeking and Off. HEVC SEI parsing has unit coverage, not full HEVC-caption playback validation. Since 0.16.0-alpha.1, separate fMP4 c708/ccdp tracks are also extracted and validated in the browser. Full justification falls back to left; display effects use snap (fade/wipe and smooth scroll are not implemented). Row/column locking is retained in the model but receiver font-size reflow/unwrapping is not implemented. Native font metrics and basic CSS edges do not promise pixel-identical broadcast rendering.

The AVC TS writer uses `avc3` with SPS/PPS in-band, preserving multiple parameter-set IDs instead of rejecting every within-segment PPS change. Existing independent frame hashes and PTS/DTS tests cover this output path.

## Encryption and CDP extension (0.16.0-alpha.1)

Initialization maps retain the encryption declaration active at EXT-X-MAP, independently of subsequent media keys or METHOD=NONE. Supported identity keys take precedence over unsupported KEYFORMAT alternatives; opaque URIs for unsupported formats are retained but never fetched by the identity decryptor. KEYFORMATVERSIONS must include version 1 for identity playback. Repeated key declarations have separate cache scopes, and failed key imports are removed from the cache. Up to 32 supported session keys are prefetched, with the imported key reused on first matching decryption. HTTP requests still use normal browser HTTP caching.

AES-128 uses CBC/PKCS#7 with a sequence-derived or explicit IV; encrypted initialization maps require an explicit IV. AES-256-GCM uses the resource's leading 16-byte IV and trailing 16-byte authentication tag, with a 32-byte identity key. An IV attribute on AES-256-GCM or SAMPLE-AES-CTR is rejected. GCM authentication failure prevents plaintext from reaching MSE. This is whole-resource encryption, not SAMPLE-AES/cenc/cbcs or DRM support.

Fetch/XHR fixtures exercise an independently encrypted map, rotating media keys, clear/encrypted transitions, session-key reuse, alternate key formats, GCM playback/seeking and tampered ciphertext rejection. Separate c708 fixtures validate CDP caption selection/geometry/P16 and media seeking. CDP time codes and service-description sections are skipped after structural checks; MP4 presentation timing and HLS master service metadata are authoritative. Multiple c708 tracks and CDP service-metadata reconciliation remain unsupported.

## SAMPLE-AES TS validation (0.17)

Identity SAMPLE-AES supports AVC and ADTS AAC with per-sample CBC reset, AVC skip encryption and outer emulation-prevention removal. Keys rotate by declaration; IVs can be explicit or derived from media sequence. The tests compare every elementary payload and timestamp and the resulting fMP4 against clear originals, then exercise playback and seeking through Fetch/XHR.

This is the MPEG-TS AVC/AAC path only. fMP4 cbcs/CENC is covered separately below; encrypted AC-3/E-AC-3 and Apple audio-setup priming metadata remain pending. The original algorithm follows [Apple's sample encryption specification](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/HLS_Sample_Encryption/Encryption/Encryption.html).

## fMP4 protection and EME (0.18)

Protected AVC/AAC fMP4 uses the browser CDM through EME. SAMPLE-AES maps to cbcs and SAMPLE-AES-CTR maps to cenc; mismatched track schemes are rejected. Identity keys are loaded from the playlist and supplied to ClearKey automatically. Other key formats require explicit application DRM configuration. HTTPS (or a browser-trusted local origin), EME support and a CDM supporting the requested codec/scheme are required.

```js
await player.load({
  protocol: 'hls',
  url: 'https://media.example.com/protected.m3u8',
  drm: {
    keySystem: 'org.w3.clearkey',
    clearKeys: {
      '0123456789abcdef0123456789abcdef': '39393939393939393939393939393939',
    },
  },
});
```

The values above belong only to the generated test fixture. Applications can instead provide `drm.license(message, messageType, signal)`, returning a promise for a license-response Uint8Array. The application selects its license endpoint and authentication. `licenseTimeoutMs` defaults to 15000; destruction aborts pending requests and closes temporary sessions. Optional `serverCertificate`, `videoRobustness` and `audioRobustness` are passed to the browser's EME APIs.

The tests cover AVC/AAC CENC subsamples and CBCS 1:9 video/full-block audio, per-sample IVs, PSSH, identity keys, direct ClearKey configuration and license callbacks. Independent FFmpeg decoding matches all 1295 audio/video frame hashes and timestamps. Browser tests cover forward/backward seeks, missing KIDs, absent DRM configuration, stalled license callbacks and media-key cleanup through Fetch/XHR. Constant-IV CBCS and alternating KID/key initialization maps are also validated with forward/backward seeks, direct keys, license callbacks and automatic identity keys. Encrypted ABR/rendition transitions remain a further interoperability target.

This does not certify Widevine, PlayReady, FairPlay, persistent/offline licenses or output-protection behavior. These need their own CDM/platform/license validation. Encrypted in-band video SEI captions cannot be decoded by JavaScript before CDM decryption; separate clear subtitle tracks remain usable.

References: [W3C EME](https://www.w3.org/TR/encrypted-media/), [CENC initialization data](https://www.w3.org/TR/eme-initdata-cenc/), ISO/IEC 23001-7.

## Packed AAC and timed metadata (0.19)

Packed ADTS AAC requires a leading ID3 PRIV transport timestamp. ID3 v2.3/v2.4, interleaved tags, 33-bit clock rollover, whole-resource AES-128 and AAC SAMPLE-AES are supported. Fifty generated segments are checked against the original ADTS bytes and timestamps. Packed MP3 is covered below; packed AC-3/E-AC-3 remain pending.

`metadata` events are emitted after a segment is appended. Their `time` is in the presentation timeline; arrival does not mean playback has reached that time. Events may be delivered again after a seek/reload. They contain `type` (`id3` or `emsg`), `frames` and `lane`; emsg also exposes scheme/value/id/duration and raw message bytes. ID3 exposes parsed private/text fields and original frame bytes. Applications own presentation-time scheduling and deduplication appropriate to their metadata semantics.

ID3 is read from MPEG-TS stream type 0x15 and packed audio. fMP4 supports emsg v0 relative and v1 absolute timestamps, including AOM/Apple ID3 schemes. Optional malformed metadata emits `metadatawarning` and does not stop A/V playback. emsg boxes are neutralized before MSE without moving sample offsets. Compressed/encrypted ID3 frames are retained as encoded bytes, not interpreted.

Generated tests cover metadata timing, byte preservation, seeks, malformed metadata recovery and Fetch/XHR. Packed-audio and timed-metadata playback/seek tests have passed in Playwright Chromium, Firefox and WebKit on Linux (60 browser cases). These are browser-engine tests, not Safari/iOS device certification.

## Packed MP3 (0.20)

Packed MPEG-1/2/2.5 Layer III supports CBR and VBR frames, ID3 timestamps, interleaved metadata, AES-128 and 33-bit timestamp rollover. The player selects `audio/mpeg` MSE when available; otherwise it remuxes complete MP3 frames to fMP4 with MPEG audio descriptors. MP3 codec aliases in playlists are normalized before capability filtering. Free-format bitrate, MPEG Layer I/II and SAMPLE-AES for MP3 are explicitly rejected.

Six generated assets are checked byte-for-byte against the encoder output, then remuxed and decoded independently with FFmpeg to compare every audio hash and timestamp. Thirty-six browser playback/seek cases pass across Playwright Chromium, Firefox and WebKit on Linux, covering Fetch/XHR for all six assets. Packed AC-3/E-AC-3 and broader cold-seek/rendition-switch interoperability remain work in progress.

## Dolby audio delivery (0.21)

AC-3 is parsed and remuxed from MPEG-TS (native stream type or registered private stream) and packed HLS audio. Packed streams require the ID3 transport timestamp; their metadata follows the same append-time event contract as AAC/MP3. AC-3 frame lengths, sample rates and channels generate a `dac3` configuration and a 1536-sample clock. AES-128 and SAMPLE-AES packed AC-3 are tested; SAMPLE-AES keeps the 16-byte frame leader clear and resets CBC per frame.

Direct fMP4 AC-3/E-AC-3 initialization reads `dac3`/`dec3`. Actual playback requires the browser to expose the codec through MSE. Linux WebKit passes playback and forward/backward seek tests for nine fixtures over Fetch/XHR; Linux Chromium and Firefox pass explicit capability-rejection tests. This does not certify Safari devices, Atmos or Dolby Vision. Packed/TS E-AC-3, encrypted TS AC-3 interoperability and audio setup/priming metadata remain follow-up work.

Independent FFmpeg decoding checks every AC-3 PCM frame and exact elementary bytes for 48/44.1/32 kHz, surround and encrypted fixtures. MP4 timing is separately checked against the fixed sample count, avoiding the raw AC-3 demuxer's accumulated 90 kHz rounding at 44.1 kHz.

## E-AC-3 TS and packed audio (0.22)

TS and packed E-AC-3 support a single independent substream, including aggregation of one/two/three-block syncframes into six-block MP4 samples. SAMPLE-AES chains encrypted blocks across syncframes within each audio sample and resets at the next sample. Clear leaders and incomplete encrypted tails remain untouched. `dec3` is generated from the bitstream configuration.

Generated 48/44.1 kHz stereo, 5.1 and SAMPLE-AES packed streams pass independent decoded PCM/hash/sample-clock checks; TS decoding is compared independently too. Synthetic tests exercise short-syncframe aggregation, CBC continuity, truncation and unsupported substreams. Dependent and multiple independent substreams are explicitly rejected in this path; Atmos object metadata and full device interoperability are not certified.

## Extended LL-HLS preloads (0.23)

Open-ended byte ranges use the RFC 8673 recommended last-byte position. Fetch retains validated response chunks and releases only the byte range subsequently announced by PART/MAP; receiving a hint alone never authorizes an MSE append. Growing requests are cancelled after consumption, on replacement or teardown. An unavailable/invalid speculative response falls back to the authoritative request. XHR cannot expose partial binary responses, so incomplete open-range requests are cancelled and replaced with bounded requests.

MAP hints survive a playlist that announces the new EXT-X-MAP before its first PART. Bounded cache size, response limits and range validation apply. Browser scenarios cover continuously growing responses, map prefetch/reuse, abandoned hints and AES-128 parts with per-parent IV changes, alongside existing partial-only startup and blocking reload tests.
