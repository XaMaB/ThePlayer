# HLS release validation

This record separates tested implementation profiles from complete protocol, codec or device certification. Release **0.45.0** promotes the media implementation tested as **0.45.0-rc.1**, source commit `99d1ae7`. Promotion changes version/documentation and strengthens the audio test harness; media algorithms are unchanged.

## Local environment

Linux, Node.js 24, Playwright 1.65.0, Chromium 158.0.8127.18, Firefox 159.0 and WebKit 27.2. Independent media decoding uses FFmpeg 6.1.1. The WebKit result is a Linux browser-engine test, not a physical Safari/iOS certification.

## Completed checks

- Formatting, TypeScript checks, isolated production build and **170 unit tests** pass.
- HE-AAC v2 synthetic stereo content: original ADTS and our remuxed MP4 decode to byte-identical PCM in independent FFmpeg checks.
- TS, fMP4 and packed HE-AAC v2: Fetch/XHR playback, distinct left/right frequencies and forward/backward seek pass in Chromium, Firefox and WebKit; all six cases also pass through the Amsterdam HTTPS test origin in Chromium.
- Apple’s public AV1 example passes against the candidate implementation, selecting HE-AAC v2 audio, rendering video, switching quality/audio, seeking and showing WebVTT. Public source results are availability-dependent and are not a substitute for generated regression fixtures.
- CEA-608: rendered background colors/opacity, AVC SEI and separate c608 tracks, service selection, early unbuffered seeks and cleanup pass across the three browser engines. The WebKit orphan-caption-payload failure has a deterministic regression.
- Steering between muxed and separate audio: VOD/live, both directions, paused position preservation and failed preflight pass across three browser engines and through the remote test origin.
- SAMPLE-AES AVC/AAC and packed AAC regression pass after the audio-profile changes.

- Complete deterministic regression of the release candidate passes (`npm run test:hls`, exit 0).
- A 30-minute live soak against the exact release-candidate build passes: 1,801.48 seconds observed, 40,589 frames, zero dropped frames, errors or live restarts. Across 360 samples, buffer health was 2.26–5.97 seconds and the reported JS heap was 6.68–54.20 MB (decimal). This measures the generated live fixture, not total browser memory or every codec/device combination.

## Completed acceptance

The [release-candidate CI workflow](https://github.com/XaMaB/ThePlayer/actions/runs/44228516664) completed successfully: build/checks, full Chromium regression and live soak, Firefox and WebKit. The complete local regression and separate 30-minute candidate soak also exited successfully. The final 0.45.0 build passes formatting, type checks and all 170 unit tests. Its media source is identical to the tested candidate; the additional audio-harness error checks pass all 24 browser/remote cases.

At the time of this release record, a separate 24-hour soak of an earlier live-delivery baseline had been started. No completed result is recorded here; it must not be attributed to the candidate binary or treated as a current running test.

## Reproduce

Run `npm run check`, `npm run fixtures:hls` and `npm run test:hls`. Install the browser engines required by Playwright. Firefox real-time audio-frequency tests on headless Linux require an audio sink; CI starts PulseAudio with a null sink. The checked-in HE-AAC fixture is original generated content, with regeneration source and provenance in `tests/fixtures/README.md`.

Use `THEPLAYER_DIST` for isolated builds/tests, `HLS_TEST_BROWSER` for the supported cross-browser suites and `HLS_RECOVERY_BASE` for the remote HTTP/TLS fixture server. `HLS_SOAK_SECONDS` selects the live soak duration. Production Origin/Relay processes are not part of these tests.

## Scope limits

See [the support matrix](hls-support.md) for codec/container, encryption and text profiles. Linux software-CDM checks do not certify FairPlay, PlayReady, hardware-secure decoding, offline licensing or physical Safari/iOS devices. Advanced typography, undeclared AAC extension detection, multi-substream Dolby and other explicitly excluded combinations remain profile limits rather than passed test cases.
