# DASH support

MPEG-DASH is **Implemented** in ThePlayer 1.3.0 for the browser fMP4/CMAF profiles below. This is a playback implementation with executable acceptance tests, not a claim of universal ISO/IEC 23009 conformance or certification for every device. See [verification](dash-validation.md), [integration](dash-integration.md) and the [delivery plan](dash-implementation-plan.md).

## Playback and delivery

| Area           | Implemented behavior                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Presentations  | Static VOD, dynamic live, DVR, audio-only, finite VOD duration and end of stream; LIVE is shown only for dynamic presentations                                                       |
| MPD            | Namespaced XML, Period/AdaptationSet/Representation inheritance, redirected and nested BaseURL/xml:base resolution, explicit required-extension filtering                            |
| Addressing     | SegmentTemplate Number/Time/RepresentationID/Bandwidth, padding, duration and Timeline, bounded repeats, exact 64-bit timestamps, PTO/eptDelta; SegmentList and byte ranges          |
| Indexes        | Version 0/1 SIDX, including bounded same-resource hierarchical indexes; child timing and reference IDs are checked                                                                   |
| Selection      | Auto/manual quality, audio language/role preference, language aliases, alternate video views, retained audio during quality changes                                                  |
| Timing         | Direct/http-iso/http-xsdate UTCTiming, MPD Location, live-edge startup, MPD and in-band producer references                                                                          |
| Recovery       | Bounded manifest/media retries, independent lanes, expired segments, pause beyond DVR, live-to-static, removed representations/Periods and bounded clock/topology recovery           |
| HTTP           | Fetch/XHR, redirects, cancellation, byte ranges, conditional ETag/Last-Modified MPD reloads and HTTP 304 reuse                                                                       |
| CDN            | BaseURL failover and serviceLocation Content Steering: startup policy, TTL, redirect-relative reloads, priority changes, clones, encoded parameter replacement, 410 and 429 handling |
| MPD updates    | Transactional MPD Patch with full-MPD fallback; XLink onLoad/onRequest, deferred Periods, local fallback and resolve-to-zero                                                         |
| Events         | EventStream/emsg v0/v1 metadata and refresh signaling; playhead-based `periodchange` for application/SSAI lifecycle integration                                                      |
| Preview images | DASH-IF JPEG thumbnail grids, row-major tiles, Period/PTO timing, bounded cache and shared seek-bar integration                                                                      |
| Telemetry      | Opt-in CMCD v1/v2 request mode using query or headers; bounded raw CMSD response fields; local QoE snapshots and events                                                              |

The engine uses separate fMP4 A/V SourceBuffers. Quality/view switches require aligned media; they do not repair arbitrary timestamp misalignment. Partially appended responses are never spliced across CDNs. HTTP 401/403 remains an explicit authorization failure.

## Codecs

| Profile                       | Browser verification                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| AVC/H.264 + AAC               | Decoded video and audio-tone checks in Chromium, Firefox and WebKit                                                    |
| AV1 fMP4                      | Decoded frames and seeking in Chromium, Firefox and WebKit                                                             |
| HEVC Main fMP4                | Decoded frames and seeking in Linux WebKit; explicit capability rejection in the tested Chromium/Firefox installations |
| AC-3 / E-AC-3 fMP4 audio-only | Playback and seeking in Linux WebKit; explicit capability rejection in the tested Chromium/Firefox installations       |

These results describe the tested browser/system decoder combinations. HEVC Main10/HDR, Dolby Vision/Atmos and hardware-specific profiles are not certified by the Main/SDR and audio-only fixtures. Shared HLS codec inspection alone is not DASH playback validation.

## Text, captions and protection

External WebVTT/TTML and fMP4 wvtt/stpp support track selection, seeks, Off, Period transitions and teardown. IMSC text uses the documented shared TTML renderer profile. Clear AVC/HEVC SEI CEA-608/708 uses the original decoders, observed service selection, cell/window positioning, P16 configuration and bounded cue history. AVC caption carriage is browser-tested; HEVC caption carriage still needs a matching fixture/device test.

ContentProtection, default KIDs, MPD/in-band PSSH and license callbacks use the shared EME controller. Chromium ClearKey tests cover CENC/CBCS, constant IV, Period key changes and in-Period `sgpd`/`sbgp` (`seig`) rotation with alternating keys and in-band PSSH. Public Axinom Widevine CBCS single/multikey tests cover playback, audio/quality changes and seeking. PlayReady/FairPlay remain provider/device integration boundaries; an accepted key-system string is not certification. Persistent/offline licenses are not implemented.

## Low latency

Fetch appends complete CMAF moof/mdat units before the HTTP response closes. AvailabilityTimeOffset/Complete control scheduling. XHR is a complete-response fallback. ServiceDescription supplies latency and playback-rate bounds; `latencyControl: true` enables catch-up, while `lowLatency: false` disables incremental append.

MPD ProducerReferenceTime and in-band `prft` map track media time to the producer clock. NTP fractions, version 0/1 media times and NTP era rollover are handled. Diagnostics distinguish MPD/in-band references and encoder/capture clocks. Producer latency is not necessarily camera-to-display latency. Transfer measurements inside CMAF units exclude producer waits between units; single-callback units fall back to conservative whole-response measurements.

## Limits and integration boundaries

- Media containers are fMP4/CMAF. DASH MPEG-TS and WebM profiles are not implemented. Static presentations require a finite duration and media initialization.
- Separate c608/c708 subtitle tracks, encrypted text, raw DVB and teletext DASH carriage are not implemented. MoQ Origin caption conversion is a separate path.
- Unknown required extensions exclude the owning Representation/AdaptationSet; unsupported required Period/MPD profiles fail explicitly. SRD/360-degree composition, scalable video and dedicated trick-mode tracks are not implemented. JPEG thumbnails and ordinary seek are supported.
- Period playback and XLink support server-side insertion. Application ad policies, VAST/VMAP execution, SCTE-35 interpretation and guaranteed seamless connected-Period splicing are not advertised. Metadata payloads never execute scripts.
- XLink expansion is bounded to five nesting levels, 32 requests and 4 MiB per resolution; the retained cache is bounded. Remote XML may contain sibling replacement elements. Non-HTTP remote schemes, external entities and DTDs are rejected.
- SIDX expansion is bounded to five child levels, 64 requests, 10,000 media references and 8 MiB of indexes. External index resources and arbitrary alternative index layouts are not advertised.
- Content Steering supports inherited media/Location service locations. Extended URL-query descriptors, replacement-only rendition inventories and steering-specific unavailable-pathway wait policies are outside the verified profile. Raw CMSD is exposed for application interpretation; it does not automatically override ABR. CMCD event/batch delivery and unspecified optional CMCD keys are not implemented.
- MPD Patch supports the documented bounded selector subset; unsupported patches fall back to a full MPD. In-band MPD refresh requests reload the manifest rather than executing embedded MPD/patch payloads.
- A decoded buffered seek stuck in the verified WebKit TextTrack/slow-startup cases is retried once after one second, with a 1 ms offset. Source clock/topology recovery permits at most three MediaSource restarts in 30 seconds. These are bounded recovery mechanisms, not repair of every malformed source.
- Browser automation on Ubuntu 24.04 is not physical Safari/iOS, Android TV or hardware-CDM certification. Codec changes require `SourceBuffer.changeType` except compatible AVC configuration changes supported by WebKit initialization data.

Use the [integration guide](dash-integration.md) for source options, standalone imports, DRM, CORS and event examples. Test commands and actual acceptance results belong in [DASH verification](dash-validation.md).
