# DASH support

The DASH engine is available as a **preview in 1.0.0-alpha.7**. This release establishes manifest addressing and fMP4 playback; it is not complete MPEG-DASH conformance. The [implementation plan](dash-implementation-plan.md) tracks the remaining stages and research sources.

## Implemented foundation

- Static and dynamic namespaced MPDs; Period, AdaptationSet and Representation inheritance.
- Nested BaseURL resolution relative to the final redirected MPD URL. Alternatives are parsed; playback currently uses the first alternative.
- SegmentTemplate with Number/Time/RepresentationID/Bandwidth substitutions and numeric padding; duration and SegmentTimeline addressing, bounded repeats, 64-bit media timestamps, presentationTimeOffset and eptDelta.
- SegmentList with initialization/media ranges; SegmentBase with a flat version 0/1 SIDX index. Hierarchical SIDX is explicitly rejected.
- Separate fragmented MP4 video/audio SourceBuffers, audio-only presentations, VOD seeking, basic same-topology Period transitions and end of stream.
- Manual video quality, throughput-based Auto selection, multilingual audio selection and retained audio choice during quality switching. Browser capability filtering occurs before selection.
- Dynamic MPD reloads, MPD Location, basic DVR seekable ranges, live-edge startup and direct/http-iso/http-xsdate UTCTiming. Failed clock synchronization is visible in diagnostics.
- Fetch or XHR, redirects, bounded network retries, byte ranges, cancellation and engine teardown using the existing ThePlayer resource client.
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

`startTime` optionally selects a presentation-time position in seconds. `targetBuffer` accepts 2–120 seconds and is a buffer target, not an end-to-end latency promise. The MPD's suggested presentation delay determines live startup when present. `?protocol=dash&src=<encoded MPD URL>` loads a DASH URL in the demo; `.mpd` URLs are also detected automatically.

For an integration without MoQ dependencies, register `DashEngine` from `dash.js` with the separate `core.js` registry. The default facade loads the DASH module lazily.

## Pending / limited

- DASH subtitles/captions (external WebVTT/TTML, wvtt/stpp, IMSC, CEA-608/708) are not exposed yet. Existing HLS subtitle support does not imply DASH support.
- ContentProtection/PSSH/default KIDs are parsed and wired to the shared EME controller, but DASH encrypted playback and key rotation have not passed their own acceptance suite. This is not a validated DASH DRM feature yet.
- Low-latency chunked delivery, ServiceDescription, ProducerReferenceTime, latency catch-up and incomplete-segment scheduling remain pending. Parsing availability attributes is not LL-DASH support.
- MPD Patch, XLink, EventStream/emsg dispatch, ad lifecycle, content steering, BaseURL failover, CMCD/CMSD and thumbnail/trick modes remain pending.
- EssentialProperty profiles are explicitly rejected pending profile-specific support; optional extension semantics are not advertised as implemented.
- Sliding Period removal, removed active representations, clock/source resets, Period track-topology changes, gaps and unaligned renditions need further recovery work. The current engine reports unsupported clock changes rather than silently rebasing them.
- Static presentations currently require a finite presentation duration; initialization is required. Media is fMP4, not TS or WebM.
- WebKit can switch compatible AVC profile/constraint configurations through new initialization data without changeType. Other codec changes require SourceBuffer.changeType. Browser automation is not physical-device certification.

## Reproducible tests

```sh
npm run fixtures:dash
npm run test:dash
DASH_TEST_BROWSER=firefox node tests/dash-browser.mjs
DASH_TEST_BROWSER=webkit node tests/dash-browser.mjs
npm run test:dash:public
```

Unit tests are included in `npm test`. Deterministic browser fixtures cover timeline/duration templates, SegmentList, redirects, PTO, Period crossing/end of stream, audio-only, live refresh and quality/audio changes over Fetch and XHR. An original FFmpeg-generated fixture supplies two video qualities and two audio tones; no third-party test media is redistributed. Chromium's audio-signal assertions require an available headless audio sink.

The opt-in public suite checks decoded frames, quality changes where offered, continued progress and VOD seeking against Akamai BBB, Envivio, Angel One and DASH-IF livesim2 Number/Timeline. External availability and CORS can change; these checks are separate from deterministic CI.
