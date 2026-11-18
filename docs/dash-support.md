# DASH support

The DASH engine is available as a **preview in 1.2.0-alpha.1**. This release establishes manifest addressing and fMP4 playback; it is not complete MPEG-DASH conformance. The [implementation plan](dash-implementation-plan.md) tracks the remaining stages and research sources.

## Implemented foundation

- Static and dynamic namespaced MPDs; Period, AdaptationSet and Representation inheritance.
- Nested BaseURL resolution relative to the final redirected MPD URL. Declared alternatives are tried after retryable failures with temporary location penalties; authentication failures stay explicit. Partially appended CMAF responses are not combined across mirrors.
- SegmentTemplate with Number/Time/RepresentationID/Bandwidth substitutions and numeric padding; duration and SegmentTimeline addressing, bounded repeats, 64-bit media timestamps, presentationTimeOffset and eptDelta.
- SegmentList with initialization/media ranges; SegmentBase with a flat version 0/1 SIDX index. Hierarchical SIDX is explicitly rejected.
- Separate fragmented MP4 video/audio SourceBuffers, audio-only presentations, VOD seeking, Period transitions with bounded MediaSource replacement for track-topology changes and end of stream.
- Manual video quality, throughput-based Auto selection, multilingual audio selection and retained audio choice during quality switching. Browser capability filtering occurs before selection.
- Dynamic MPD reloads, MPD Location, basic DVR seekable ranges, live-edge startup and direct/http-iso/http-xsdate UTCTiming. Failed clock synchronization is visible in diagnostics.
- Fetch or XHR, redirects, bounded network retries, byte ranges, cancellation and engine teardown using the existing ThePlayer resource client.
- Bounded live MPD/segment recovery across temporary HTTP/network failures; independent lane retry scheduling; expired-segment handling and DVR recovery after resume. Pausing retains the playhead; live-to-static MPDs finish as VOD. Authentication failures remain explicit.
- MediaInfo, shared controls and LIVE only for dynamic presentations. Public examples are available in the demo's DASH selector.

AVC/AAC playback is tested. Other fMP4 sample entries accepted by the shared inspector still require DASH-specific codec/device validation. Audio tests verify decoded 440/880 Hz signals, not just selection labels. Quality switching assumes aligned representations; it does not repair arbitrarily misaligned sources.

## Integration

See [the integration guide](dash-integration.md) for options, standalone engine registration, DRM, CORS and metadata, and [the verification matrix](dash-validation.md) for executable tests.

```js
import { ThePlayer } from './dist/player.js';

const player = new ThePlayer(video);
await player.load({
  protocol: 'dash',
  url: 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
  quality: 'auto',
  targetBuffer: 12,
  audioLanguage: 'en',
  network: { transport: 'fetch' }, // or 'xhr'
});
// await player.selectQuality(0); // index in player.qualityLevels
// await player.selectQuality(-1); // Auto
// await player.selectAudioTrack(player.audioTracks[0].name);
// await player.destroy();
```

`liveRecoveryWindowMs` sets the live scheduling recovery window (default 30000 ms, allowed 1000–120000). It bounds repeated failures after the first failed request; in-flight requests also have their own timeout. Live scheduler retries replace per-resource retry loops so successful lanes can progress between attempts. VOD and initial loading retain the resource client retry policy. After a DVR overrun, the recovery target leaves up to two seconds of decode headroom inside short windows; a pending seek may be retried after two seconds if its target has expired. Counters are available in `player.diagnostics.recovery` and do not expose signed resource URLs.

`startTime` optionally selects a presentation-time position in seconds. `targetBuffer` accepts 2–120 seconds and is a buffer target, not an end-to-end latency promise. The MPD's suggested presentation delay determines live startup when present. `?protocol=dash&src=<encoded MPD URL>` loads a DASH URL in the demo; `.mpd` URLs are also detected automatically.

For an integration without MoQ dependencies, register `DashEngine` from `dash.js` with the separate `core.js` registry. The default facade loads the DASH module lazily.

## Pending / limited

- External WebVTT/TTML and fMP4 wvtt/stpp are implemented with the shared text renderers, selection, seek, Off and teardown. IMSC text inherits the TTML renderer profile limits. Clear AVC/HEVC SEI CEA-608/708 uses the shared original decoders, selectable observed services, cell/window placement, P16 configuration and bounded history. AVC caption playback is verified; HEVC caption playback still needs a capable device. Separate DASH c608/c708 tracks and encrypted text remain pending.
- ContentProtection/PSSH/default KIDs use the shared EME controller. CENC/CBCS, constant IV and Period-bound key rotation pass ClearKey playback/seek/teardown tests. Public Axinom Widevine CBCS single-key/multikey playback, audio/quality selection and seeks pass in full Chromium. PlayReady/FairPlay device certification and in-Period key rotation remain pending.
- LL-DASH Fetch delivery appends complete CMAF moof/mdat units before the HTTP response closes. ATO/ATC schedule incomplete segments; ServiceDescription supplies target latency and rate bounds. Set `latencyControl: true` to enable bounded catch-up; `lowLatency: false` disables incremental appends. XHR waits for complete responses. MPD ProducerReferenceTime supports UTC date-time wall clocks, inheritance by ID and exact media timestamps; latency diagnostics and rate control use the selected reference. In-band prft, non-date-time producer clocks and long-running network/latency soaks remain pending.
- MPD Patch validates MPD identity/publication times and applies bounded add/remove/replace selectors transactionally; unsupported selectors, stale updates and HTTP failures fall back to full MPDs. Set `useMpdPatch: false` to disable. Public DASH-IF Patch playback is tested. EventStream and emsg v0/v1 emit bounded, deduplicated metadata; in-band MPD refresh signaling schedules a reload. XLink, ad lifecycle, content steering, CMCD/CMSD and thumbnail/trick modes remain pending.
- Unknown EssentialProperty excludes its Representation or AdaptationSet; supported siblings remain available. Unsupported required Period/MPD profiles or a Period with no usable adaptations fail explicitly. Optional extension semantics are not advertised as implemented.
- Removed active representations fall back to an available compatible quality; replacement Periods with unchanged track topology are supported. A decoded, buffered seek that remains pending can be retried once after one second with a 1 ms offset; this handles the verified WebKit native-TextTrack case and is counted in `recovery.seekRetries`. AST/Period/timing changes and audio/video topology changes use bounded MediaSource recovery (at most three restarts in 30 seconds). Arbitrary gaps, unaligned renditions and all source-replacement patterns are not covered by this mechanism.
- Static presentations currently require a finite presentation duration; initialization is required. Media is fMP4, not TS or WebM.
- WebKit can switch compatible AVC profile/constraint configurations through new initialization data without changeType. Other codec changes require SourceBuffer.changeType. Browser automation is not physical-device certification.

## Reproducible tests

```sh
npm run fixtures:dash
npm run test:dash
DASH_TEST_BROWSER=firefox node tests/dash-browser.mjs
DASH_TEST_BROWSER=webkit node tests/dash-browser.mjs
npm run test:dash:recovery
npm run test:dash:public
```

Unit tests are included in `npm test`. Deterministic browser fixtures cover timeline/duration templates, SegmentList, redirects, PTO, Period crossing/end of stream, audio-only, live refresh and quality/audio changes over Fetch and XHR. An original FFmpeg-generated fixture supplies two video qualities and two audio tones; no third-party test media is redistributed. Chromium's audio-signal assertions require an available headless audio sink.

The opt-in public suite checks decoded frames, quality changes where offered, continued progress and VOD seeking against Akamai BBB, Envivio, Angel One and DASH-IF livesim2 Number/Timeline. External availability and CORS can change; these checks are separate from deterministic CI.

The recovery suite injects three consecutive MPD failures, three media failures, long pauses beyond a short DVR window, dynamic-to-static completion, exhausted recovery windows, HTTP 403 and a delayed expired HTTP 410 segment. Each scenario runs over Fetch/XHR; it verifies playback progress or the expected bounded fatal error, plus teardown.

Version 1.1 adds independent text loading, tested DRM and low-latency delivery. Text and LL browser suites run over Fetch/XHR in Chromium, Firefox and WebKit. DRM fixture tests use Chromium ClearKey; the opt-in `npm run test:dash:widevine` uses [Axinom public test vectors](https://github.com/Axinom/public-test-vectors) without redistributing media or entitlements.

Public [DASH-IF livesim2](https://github.com/Dash-Industry-Forum/livesim2/wiki/URL-Parameters) Patch and low-latency streams pass opt-in playback tests in addition to controlled fixtures.

## Current increment

Version 1.2 adds captions, BaseURL failover, clock/topology recovery and metadata. Text follows the playback Period even when A/V has prefetched the next Period; backward/forward seeks and presentationTimeOffset have dedicated coverage. The public CEA-608 livesim stream is included in the opt-in public suite. This is additional tested behavior, not completion of every optional stage in the plan.
