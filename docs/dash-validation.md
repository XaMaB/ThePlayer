# DASH verification

This record describes verified behavior and executable tests, not full ISO/IEC 23009 conformance or device certification. The current [support matrix](dash-support.md) and [delivery plan](dash-implementation-plan.md) take precedence over historical milestone notes.

## Deterministic coverage

Fixtures are generated locally with FFmpeg and the project's original caption, text and encryption fixture builders. No private channel captures or publisher media are redistributed.

| Suite                       | Checks                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                  | DASH duration/addressing, exact large timestamps, ranges/hierarchical SIDX, CMCD/steering and incremental CMAF framing, alongside HLS unit tests                          |
| `dash-mpd-browser.mjs`      | XML/inheritance, timing, unsafe/malformed input, transactional Patch, producer references and required-extension scope                                                    |
| `dash-browser.mjs`          | Templates/Timeline/List, redirects, PTO, Periods, audio-only/live, quality/audio switches and declared CDN failover                                                       |
| `dash-recovery-browser.mjs` | MPD/media outages, exhausted budget, authorization, expiry, DVR pause/resume, live-to-static, removed quality/Period, Patch fallback, clock/topology resets               |
| `dash-text-browser.mjs`     | External WebVTT/TTML and MP4 wvtt/stpp; Period/PTO, seeks, Off and teardown                                                                                               |
| `dash-captions-browser.mjs` | AVC SEI CEA-608/708, separate services, alignment, P16, seeks and Off                                                                                                     |
| `dash-ll-browser.mjs`       | Fetch frames before HTTP completion, XHR full-response fallback, ServiceDescription rate bounds and MPD/in-band producer-clock latency and intra-chunk transfer estimates |
| `dash-metadata-browser.mjs` | EventStream/emsg timestamps, payloads, deduplication and continued playback                                                                                               |
| `dash-ui-browser.mjs`       | Demo source detection, quality/audio controls, live-state visibility and release version                                                                                  |
| `dash-drm-browser.mjs`      | ClearKey cenc/cbcs, constant IV, Period and in-Period seig key rotation, seeking and mediaKeys cleanup                                                                    |

Additional suites in `test:dash`:

| Suite                                               | Checks                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dash-xlink-resolver.mjs`, `dash-xlink-browser.mjs` | Deferred Periods, redirects, default content, repeated decisions, sibling elements, resolve-to-zero, recursion bounds and real seek/playback |
| `dash-http-browser.mjs`                             | ETag 200/304 retention and changed-body reloads                                                                                              |
| `dash-steering-browser.mjs`                         | Query-before-start, TTL priority changes, failed CDN and HTTP 410 retention                                                                  |
| `dash-thumbnail-browser.mjs`                        | Decoded JPEG grids, tile order, cache reuse and URL cleanup                                                                                  |
| `dash-views-browser.mjs`                            | Decoded alternate video views, switch-back and language alias selection                                                                      |
| `dash-telemetry-browser.mjs`                        | CMCD v1/v2 query/header requests, raw CMSD, local QoE and playhead Period events                                                             |
| `dash-codecs-browser.mjs`                           | AV1/HEVC/AC-3/E-AC-3 decoding and seek where supported; explicit capability rejection otherwise                                              |

Playback suites use Fetch and XHR. CI is pinned to Ubuntu 24.04 to match the validated system media libraries; Ubuntu 26.04 WebKit is not currently part of the verified matrix. Each base playback scenario has a two-minute watchdog covering browser RPCs and teardown, with its last phase reported on timeout. PASS is printed after cleanup. The CI matrix runs `test:dash` in Chromium, Firefox and WebKit; ClearKey is a separate Chromium step. Linux Firefox audio-frequency checks require an audio sink. Browser-engine results are not physical Safari/iOS, Android TV or hardware-CDM certification.

## Reproduce

```sh
npm ci
npm run bootstrap
npx playwright install chromium firefox webkit
npm run fixtures:dash
npm run check
npm run test:dash
DASH_TEST_BROWSER=firefox npm run test:dash
DASH_TEST_BROWSER=webkit npm run test:dash
npm run test:dash:drm
DASH_SOAK_SECONDS=180 npm run test:dash:soak
```

Use `THEPLAYER_DIST=/absolute/candidate` for isolated builds and tests, and `THEPLAYER_DASH_FIXTURES=/absolute/fixtures` to choose generated media storage. Set the same paths for generation/build and tests. `DASH_SCENARIOS` and `DASH_RECOVERY_SCENARIOS` select comma-separated subsets of their respective suites. Fixture generation requires FFmpeg with AVC/AAC, libaom-av1, libx265, AC-3 and E-AC-3 encoders. Origin/Relay production services are not part of the harness.

## Public interoperability

`npm run test:dash:public` fetches publisher-hosted media and checks actual playback, continued progress, available quality changes and VOD seeking. The corpus includes Akamai BBB, Envivio, Angel One and DASH-IF livesim2 Number/Timeline, Patch, low-latency CMAF and CEA-608. Use `DASH_PUBLIC_SOURCE` to select a source ID from the script. All these profiles have passed local browser playback; public availability and CORS can change.

`npm run test:dash:widevine` uses Axinom public CBCS single/multikey vectors in full Chromium with an available Widevine CDM. Fetch/XHR playback, audio/quality switches, seeking, license responses and cleanup have passed. Public DRM endpoints and entitlements are external dependencies and are not part of deterministic CI.

## Shared-code regressions and remaining acceptance

The full-resource Fetch chunk callback is shared with HLS. LL-HLS open-range, MAP and encrypted-range regressions pass after this change. This is a targeted regression result, not a claim that every HLS browser suite was rerun for every DASH-only edit. See [the HLS release record](hls-validation.md) for its separate acceptance history.

The deterministic live soak repeats original media with advancing decode clocks, changes quality/audio, pauses and injects HTTP failures. It asserts continuing decoded frames, bounded forward buffer and no unexpected timeline restart. `DASH_SOAK_SECONDS` controls its duration; the CI smoke soak is three minutes and does not replace long-run acceptance.

Longer deterministic live/LL/DRM tests supplement the browser suites. Physical commercial-CDM/device certification and unsupported optional profiles remain separate from the implemented release. Unit success, HTTP 200, parsed codec declarations and ClearKey playback are not substitutes for those results. New release candidates must rerun affected suites and record actual failures before promotion.

## 1.2 candidate findings

The three-minute generated live fault/switch/pause soak completed for 181.09 seconds with 4,401 decoded frames, zero reported errors or timeline restarts, and sampled forward buffer 2.99–7.89 seconds for a six-second target. This is a short deterministic resilience result, not long-run LL or DRM certification; the fixture's response timing differs from a production CDN.

Expanded WebKit text/Period testing exposed a pending-seek problem after a native TextTrack is created following an earlier seek, even with decoded A/V data covering the target. An isolated probe reproduced it and verified that a distinct seek 1 ms later releases the browser. The engine now retries once after one second, only when the target has decoded buffered media and all lane appends/preroll have settled. It preserves pause, records `recovery.seekRetries` and does not retry unavailable media indefinitely. VTT history is retained and deduplicated during Period seeks. The expanded text regression checks active cues and playback progress.

## 1.3 release acceptance

The extended suite verifies XLink, hierarchical SIDX, in-band producer time, ETag, steering, thumbnails, alternate views, CMCD/CMSD/QoE and in-Period encryption groups. AV1 decodes and seeks in Chromium, Firefox and WebKit. Linux WebKit also decodes the HEVC Main and AC-3/E-AC-3 fixtures; Chromium/Firefox explicitly reject these codecs on this host. This is not Main10/HDR, Atmos or physical-device certification.

`test:dash:ll-soak` uses a continuously advancing timeline with producer-paced CMAF units, transfer delay, jitter and HTTP failures. `test:dash:drm-soak` repeatedly crosses in-Period key changes and seeks backward, checking decoded frames, session reuse and cleanup. Use `DASH_SOAK_SECONDS` to choose a duration. Release-specific measurements are recorded in the [1.3.0 release notes](https://github.com/XaMaB/ThePlayer/releases/tag/v1.3.0).

## 1.4 ABR policy regression

`test:abr:policy` exercises three-profile HLS/DASH ladders over Fetch/XHR: highest startup, lowest-to-highest direct upgrade, numeric manual override, and a throttled link that forces the highest start down to the lowest profile. It checks decoded resolution, initial resource selection, Auto state, diagnostics and demo settings/snippets in Chromium and WebKit.

Slow DASH startup exposed a separate WebKit seek remaining pending at the initial position with decoded buffered A/V. Startup positioning now participates in the existing bounded one-millisecond retry, after at least one second and only with buffered decoded media and no pending append/preroll. Automatic DASH adaptation waits for seeking to finish. The test verifies continued decoded playback and at most one startup retry.
