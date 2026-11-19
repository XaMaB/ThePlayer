# DASH implementation plan

Research baseline: 18 November 2026. The browser fMP4/CMAF playback profile is implemented in 1.3.0; the existence of an engine entry point is not a claim of complete DASH conformance. Each stage needs parser/unit tests, deterministic browser media tests and an updated support matrix before it is marked complete.

## Standards and references

- [ISO/IEC 23009-1:2026, edition 6](https://www.iso.org/standard/23009-1): current published MPD/segment specification, published July 2026. The catalogue and public material were consulted; this is not a claim to have reviewed all 375 pages of the licensed standard.
- [MPEG DASH sixth-edition MPD schema](https://github.com/MPEGGroup/DASHSchema/blob/6th-Ed/DASH-MPD.xsd): public element and attribute definitions, including ProducerReferenceTime.
- [DASH-IF IOP v5](https://dashif.org/guidelines/iop-v5/): independently maintained interoperability guidance for CMAF, VOD/live, protection, audio/video/text and events.
- [DASH-IF timing model](https://dashif.org/Guidelines-TimingModel/): presentation/sample clocks, addressing and availability.
- [MPD Patch guidance](https://dashif.org/DASH-IF-IOP/mpd-patch/): incremental timeline updates and full-MPD fallback.
- [ETSI TS 103 998 Content Steering](https://www.etsi.org/deliver/etsi_ts/103900_103999/103998/01.01.01_60/ts_103998v010101p.pdf): service locations, priorities, clones and server response handling.
- [CTA-5004-B CMCD, April 2026](https://cta-wave.github.io/Resources/common-media-client-data--cta-5004-b.html): version 2 request-mode fields and version 1 compatibility.
- [W3C EME ISO Common Encryption stream format](https://www.w3.org/TR/eme-stream-mp4/): PSSH and sample-group encryption signaling.
- [DASH-IF security guidance](https://dashif.org/Guidelines-Security/): content-protection signaling and license integration.
- [DASH-IF livesim2](https://livesim.dashif.org/) and [asset catalogue](https://livesim.dashif.org/assets): public live/low-latency and configurable test delivery.

Player code is implemented in `src/engines/dash/`. Existing ThePlayer HTTP, throughput estimation, MP4 inspection and EME components are reused; there is no dependency on another DASH playback engine.

## Delivery stages

| Stage                               | Scope                                                                                                                                                                                                                                                      | Acceptance                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1. Manifest and addressing          | Namespaced XML; Period/AdaptationSet/Representation; BaseURL inheritance; static/dynamic timing; duration/Timeline templates; Number/Time/RepresentationID/Bandwidth substitution; repeat bounds; PTO/eptDelta; SegmentList; flat/hierarchical SIDX ranges | Exact URL/timestamp assertions, malformed-input limits, large timestamp/repeat tests                    |
| 2. Media foundation                 | Separate fMP4 A/V, VOD/live, startup, buffer management, seek, Period transitions, quality selection/ABR, audio selection, Fetch/XHR and redirects                                                                                                         | Decoded frames/audio, seek and switching through deterministic server; public streams                   |
| 3. Live resilience                  | UTCTiming alternatives, MPD validity/reloads, DVR, dynamic-to-static, sliding Period removal, discontinuities, source replacement, errors/retries, codec/topology changes                                                                                  | Clock skew, unavailable/expired segments, network interruption, pause/resume, long-running tests        |
| 4. Text and captions                | External WebVTT/TTML, wvtt/stpp, IMSC text, language/role/accessibility selection, clear in-band CEA-608/708; selection/seek/teardown                                                                                                                      | Reuse validated renderers; actual on-screen cue/time/geometry tests for DASH carriage                   |
| 5. Protection                       | MPD/in-band PSSH, cenc/cbcs, default KIDs, key rotation, license callback/auth/certificates, ClearKey/Widevine; platform-specific PlayReady/FairPlay work                                                                                                  | Independent encrypted fixtures, rotation/seeks/cleanup, explicit CDM/device matrix                      |
| 6. Low latency                      | CMAF chunk delivery, availabilityTimeOffset/Complete, ServiceDescription, ProducerReferenceTime, latency target/rate control, ABR for chunked transfers                                                                                                    | First decoded frames before complete segment arrival; bounded latency under jitter                      |
| 7. Manifest/event extensions        | MPD Patch + fallback, XLink, EventStream/emsg, in-band refresh events, connected/continuous Periods and ad insertion lifecycle                                                                                                                             | Timing/seek/deduplication and malformed extension tests; no execution of media-provided scripts         |
| 8. Delivery selection and telemetry | Multiple BaseURL/serviceLocation, failover, content steering, request hooks, ETag/304, CMCD/CMSD and QoE export                                                                                                                                            | Deterministic CDN outages, signed redirects, credential scoping, telemetry assertions                   |
| 9. Extended media/presentation      | Additional codec/container profiles, HDR signaling, audio roles/channels, thumbnails/trick modes, alternate views/SRD; hierarchical indexes                                                                                                                | Capability-filtered choices, per-profile fixtures; explicit rejection for unsupported required features |
| 10. Release acceptance              | Cross-browser and physical-device verification, longer live/LL/DRM soaks, public interoperability corpus, documentation                                                                                                                                    | No blanket claims based only on parser acceptance; retain HLS regression checks                         |

Stages can share work, but an extension remains pending until its playback behavior is verified. Browser codec/CDM support and physical-device certification are separate from manifest recognition. Future amendments under development are not treated as published requirements.

## Public streams checked

The following MPDs returned HTTP 200 on 18 November 2026. HTTP availability is not itself proof of successful playback. Network-dependent tests stay separate from deterministic CI; media remains hosted by its publisher.

| Source                               | URL                                                                         | Delivery                                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Akamai Big Buck Bunny                | <https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd>                 | VOD, duration templates, multiple video qualities, separate audio                               |
| Envivio                              | <https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd>              | VOD, multiple qualities                                                                         |
| Google Shaka demo assets: Angel One  | <https://storage.googleapis.com/shaka-demo-assets/angel-one/dash.mpd>       | VOD, SegmentBase/SIDX, multilingual audio/text; using test media does not add Shaka player code |
| DASH-IF livesim2 number addressing   | <https://livesim.dashif.org/livesim2/testpic_2s/Manifest.mpd>               | Live, wall-clock synchronization                                                                |
| DASH-IF livesim2 timeline addressing | <https://livesim.dashif.org/livesim2/segtimeline_1/testpic_2s/Manifest.mpd> | Live SegmentTimeline                                                                            |

`tests/dash-public.mjs` probes decoded playback, quality changes, continued progress and VOD seeking. Low-latency, MPD Patch and CEA-608 profiles are now included in the public suite; multi-period fixtures remain deterministic local tests.

## First delivery: 1.0.0-alpha.8

The manifest/addressing foundation and basic fMP4 playback are implemented. All five public sources above passed decoded playback and continued progress; the three VOD sources also passed quality changes and seeking. Remaining stage-specific limitations are explicit in [DASH support](dash-support.md). This does not mark all ten stages complete.

## Live recovery increment: 1.0.0-alpha.9

Stage 3 now includes bounded MPD and segment recovery, per-lane retry scheduling, expired-segment recovery, pause/resume beyond the DVR window and live-to-static completion. Deterministic fault tests cover Fetch/XHR in Chromium, Firefox and WebKit. Sliding Period removal, changed active representations, clock resets, topology changes and long-running soaks remain open; stage 3 is not marked fully complete.

## Text, protection and low latency: 1.1.0-alpha.1

Adds active-representation/Period replacement, external and MP4 text, CENC/CBCS ClearKey, public Widevine single/multikey validation, and Fetch CMAF chunk appends before HTTP completion with ServiceDescription latency/rate settings. XHR remains a full-response fallback. Extension and device-specific limits remain listed in the support matrix; the final documentation audit is still required before the implemented release.

## Captions and delivery resilience: 1.2.0-alpha.1

Adds clear video SEI CEA-608/708, P16/service selection, BaseURL failover, bounded source-clock/topology recovery, EventStream/emsg dispatch and MPD producer-clock latency mapping. Text tests cover PTO and playback Period transitions. Unknown required extensions are excluded at their owning adaptation/representation scope. See [current support](dash-support.md), [integration](dash-integration.md) and [verification](dash-validation.md); milestone entries above describe historical state.

## Implemented browser profile: 1.3.0

The implemented release adds XLink, hierarchical indexes, in-band producer references, producer-paced transfer measurement, ETag/304, Content Steering, thumbnails, alternate video views, canonical audio language/role choice, CMCD request telemetry, raw CMSD and QoE export. Server-inserted Periods expose playhead lifecycle events. CENC/CBCS in-Period sample-group rotation is verified with independent fixtures. AV1/HEVC/AC-3/E-AC-3 have explicit browser playback/capability results.

Release acceptance is based on decoded media, cross-browser deterministic suites, public interoperability and sustained fault/latency/DRM runs, recorded in [verification](dash-validation.md). “Implemented” refers to this tested profile. It does not silently mark every optional item in the research table universally supported.

The [support matrix](dash-support.md) retains the remaining boundaries: MPEG-TS/WebM DASH containers, SRD/scalable/360-degree composition, dedicated trick-mode tracks, separate/encrypted caption tracks, non-date-time producer clocks, extended steering query descriptors/inventory replacement, embedded MPD event execution, application ad policy, and physical PlayReady/FairPlay/HDR certification. These require additional profile-specific work and are not claimed complete by the 1.3 release.
