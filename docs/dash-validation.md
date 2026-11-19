# DASH verification

This record describes verified behavior and executable tests, not full ISO/IEC 23009 conformance or device certification. The current [support matrix](dash-support.md) and [remaining plan](dash-implementation-plan.md) take precedence over historical milestone notes.

## Deterministic coverage

Fixtures are generated locally with FFmpeg and the project's original caption, text and encryption fixture builders. No private channel captures or publisher media are redistributed.

| Suite                       | Checks                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                  | DASH duration/addressing, exact large timestamps, ranges/SIDX and incremental CMAF framing, alongside HLS unit tests                                        |
| `dash-mpd-browser.mjs`      | XML/inheritance, timing, unsafe/malformed input, transactional Patch, producer references and required-extension scope                                      |
| `dash-browser.mjs`          | Templates/Timeline/List, redirects, PTO, Periods, audio-only/live, quality/audio switches and declared CDN failover                                         |
| `dash-recovery-browser.mjs` | MPD/media outages, exhausted budget, authorization, expiry, DVR pause/resume, live-to-static, removed quality/Period, Patch fallback, clock/topology resets |
| `dash-text-browser.mjs`     | External WebVTT/TTML and MP4 wvtt/stpp; Period/PTO, seeks, Off and teardown                                                                                 |
| `dash-captions-browser.mjs` | AVC SEI CEA-608/708, separate services, alignment, P16, seeks and Off                                                                                       |
| `dash-ll-browser.mjs`       | Fetch frames before HTTP completion, XHR full-response fallback, ServiceDescription rate bounds and MPD producer-clock latency                              |
| `dash-metadata-browser.mjs` | EventStream/emsg timestamps, payloads, deduplication and continued playback                                                                                 |
| `dash-ui-browser.mjs`       | Demo source detection, quality/audio controls, live-state visibility and release version                                                                    |
| `dash-drm-browser.mjs`      | ClearKey cenc/cbcs, constant IV, Period key rotation, seeking and mediaKeys cleanup                                                                         |

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

Use `THEPLAYER_DIST=/absolute/candidate` for isolated builds and tests, and `THEPLAYER_DASH_FIXTURES=/absolute/fixtures` to choose generated media storage. Set the same paths for generation/build and tests. `DASH_SCENARIOS` and `DASH_RECOVERY_SCENARIOS` select comma-separated subsets of their respective suites. Fixture generation requires FFmpeg with AVC/AAC encoding. Origin/Relay production services are not part of the harness.

## Public interoperability

`npm run test:dash:public` fetches publisher-hosted media and checks actual playback, continued progress, available quality changes and VOD seeking. The corpus includes Akamai BBB, Envivio, Angel One and DASH-IF livesim2 Number/Timeline, Patch, low-latency CMAF and CEA-608. Use `DASH_PUBLIC_SOURCE` to select a source ID from the script. All these profiles have passed local browser playback; public availability and CORS can change.

`npm run test:dash:widevine` uses Axinom public CBCS single/multikey vectors in full Chromium with an available Widevine CDM. Fetch/XHR playback, audio/quality switches, seeking, license responses and cleanup have passed. Public DRM endpoints and entitlements are external dependencies and are not part of deterministic CI.

## Shared-code regressions and remaining acceptance

The full-resource Fetch chunk callback is shared with HLS. LL-HLS open-range, MAP and encrypted-range regressions pass after this change. This is a targeted regression result, not a claim that every HLS browser suite was rerun for every DASH-only edit. See [the HLS release record](hls-validation.md) for its separate acceptance history.

The deterministic live soak repeats original media with advancing decode clocks, changes quality/audio, pauses and injects HTTP failures. It asserts continuing decoded frames, bounded forward buffer and no unexpected timeline restart. `DASH_SOAK_SECONDS` controls its duration; the CI smoke soak is three minutes and does not replace long-run acceptance.

Long live/LL fault soaks, broader codec/device coverage, optional extension interoperability and physical commercial-CDM verification remain open. Unit success, HTTP 200, parsed codec declarations and ClearKey playback are not substitutes for those results. New release candidates must rerun affected suites and record actual failures before promotion.

## 1.2 candidate findings

The three-minute generated live fault/switch/pause soak completed for 181.09 seconds with 4,401 decoded frames, zero reported errors or timeline restarts, and sampled forward buffer 2.99–7.89 seconds for a six-second target. This is a short deterministic resilience result, not long-run LL or DRM certification; the fixture's response timing differs from a production CDN.

Expanded WebKit text/Period testing exposed a pending-seek problem after a native TextTrack is created following an earlier seek, even with decoded A/V data covering the target. An isolated probe reproduced it and verified that a distinct seek 1 ms later releases the browser. The engine now retries once after one second, only when the target has decoded buffered media and all lane appends/preroll have settled. It preserves pause, records `recovery.seekRetries` and does not retry unavailable media indefinitely. VTT history is retained and deduplicated during Period seeks. The expanded text regression checks active cues and playback progress.
