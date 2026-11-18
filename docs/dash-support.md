# DASH support

The DASH engine is available as a **preview in 1.1.0-alpha.1**. This release establishes manifest addressing and fMP4 playback; it is not complete MPEG-DASH conformance. The [implementation plan](dash-implementation-plan.md) tracks the remaining stages and research sources.

## Implemented foundation

- Static and dynamic namespaced MPDs; Period, AdaptationSet and Representation inheritance.
- Nested BaseURL resolution relative to the final redirected MPD URL. Alternatives are parsed; playback currently uses the first alternative.
- SegmentTemplate with Number/Time/RepresentationID/Bandwidth substitutions and numeric padding; duration and SegmentTimeline addressing, bounded repeats, 64-bit media timestamps, presentationTimeOffset and eptDelta.
- SegmentList with initialization/media ranges; SegmentBase with a flat version 0/1 SIDX index. Hierarchical SIDX is explicitly rejected.
- Separate fragmented MP4 video/audio SourceBuffers, audio-only presentations, VOD seeking, basic same-topology Period transitions and end of stream.
- Manual video quality, throughput-based Auto selection, multilingual audio selection and retained audio choice during quality switching. Browser capability filtering occurs before selection.
- Dynamic MPD reloads, MPD Location, basic DVR seekable ranges, live-edge startup and direct/http-iso/http-xsdate UTCTiming. Failed clock synchronization is visible in diagnostics.
- Fetch or XHR, redirects, bounded network retries, byte ranges, cancellation and engine teardown using the existing ThePlayer resource client.
- Bounded live MPD/segment recovery across temporary HTTP/network failures; independent lane retry scheduling; expired-segment handling and DVR recovery after resume. Pausing retains the playhead; live-to-static MPDs finish as VOD. Authentication failures remain explicit.
- MediaInfo, shared controls and LIVE only for dynamic presentations. Public examples are available in the demo's DASH selector.

AVC/AAC playback is tested. Other fMP4 sample entries accepted by the shared inspector still require DASH-specific codec/device validation. Audio tests verify decoded 440/880 Hz signals, not just selection labels. Quality switching assumes aligned representations; it does not repair arbitrarily misaligned sources.

## Integration

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

- External WebVTT/TTML and fMP4 wvtt/stpp are implemented with the shared text renderers, selection, seek, Off and teardown. IMSC text inherits the TTML renderer profile limits. DASH CEA-608/708 and encrypted text remain pending.
- ContentProtection/PSSH/default KIDs use the shared EME controller. CENC/CBCS, constant IV and Period-bound key rotation pass ClearKey playback/seek/teardown tests. Public Axinom Widevine CBCS single-key/multikey playback, audio/quality selection and seeks pass in full Chromium. PlayReady/FairPlay device certification and in-Period key rotation remain pending.
- LL-DASH Fetch delivery appends complete CMAF moof/mdat units before the HTTP response closes. ATO/ATC schedule incomplete segments; ServiceDescription supplies target latency and rate bounds. Set `latencyControl: true` to enable bounded catch-up; `lowLatency: false` disables incremental appends. XHR waits for complete responses. ProducerReferenceTime and long-running network/latency soaks remain pending.
- MPD Patch validates MPD identity/publication times and applies bounded add/remove/replace selectors transactionally; unsupported selectors, stale updates and HTTP failures fall back to full MPDs. Set `useMpdPatch: false` to disable. Public DASH-IF Patch playback is tested. XLink, EventStream/emsg dispatch, ad lifecycle, content steering, BaseURL failover, CMCD/CMSD and thumbnail/trick modes remain pending.
- EssentialProperty profiles are explicitly rejected pending profile-specific support; optional extension semantics are not advertised as implemented.
- Removed active representations fall back to an available compatible quality; replacement Periods with unchanged track topology are supported. Clock/source resets, Period track-topology changes, gaps and unaligned renditions need further recovery work. The current engine reports unsupported clock changes rather than silently rebasing them.
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
