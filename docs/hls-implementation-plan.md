# HLS implementation plan

Status: original HLS engine with AVC/HEVC/AAC TS/fMP4, AV1 fMP4, audio-only, ABR, external audio, WebVTT and fMP4 CEA-608. Versions 0.8–0.9 add bounded network recovery, declared gaps, live publisher progress, coordinated encoder/window restarts and complete PSI assembly. See [current support](hls-support.md). The remaining stages below are active work, not completed capabilities.

| Stage                   | Current status                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Fault infrastructure    | Local/remote HTTP scenarios, Fetch/XHR checks and CI integration implemented                                                             |
| Recovery / timeline     | Network, declared gaps, stale publisher and detected live resets implemented; additional edge-case coverage continues                    |
| TS/fMP4 hardening       | Multi-packet/versioned PSI, CRC and AVC/HEVC access-unit/PES assembly implemented; remaining timing/seek edge cases continue             |
| ABR / buffer policy     | Emergency request abort, bounded fallback and temporary rendition quarantine implemented                                                 |
| LL-HLS                  | fMP4 parts, blocking/delta, open-range/MAP preloads and encrypted parts implemented; expanded interoperability continues                 |
| Subtitles               | WebVTT, stpp/TTML, wvtt and fMP4 CEA-608 subsets implemented; broader CEA carriage and advanced text features pending                    |
| Protection / extensions | AES-128/GCM, sample encryption, EME and timed metadata implemented; steering implemented for matching inventories; interstitials pending |
| Stabilization           | Regression matrix active; long-running live soak started; device-specific validation remains required                                    |

## Specification baseline

- RFC 8216: https://www.rfc-editor.org/rfc/rfc8216
- HTTP Live Streaming 2nd Edition, draft 22: https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis-22
- Apple's 2026 updates: https://developer.apple.com/streaming/Whats-new-HLS.pdf

Reviewed 2026-11-17. The second edition is an Internet-Draft, not a published RFC. Apple also describes newer preliminary additions. Record the supported features individually; do not equate accepting an EXT-X-VERSION number with implementing every requirement of that version.

## Engine boundaries

1. Playlist parser: immutable multivariant/media models, attribute grammar, relative URI resolution, variables, sequences, discontinuities, byte ranges, encryption descriptors and rendition groups.
2. Resource loading: Fetch/XHR adapters with cancellation, timeouts, bounded retry, redirect-aware base URLs, request customization and byte ranges.
3. Playlist scheduling: ordinary reload, unchanged-playlist timing, conditional retrieval where appropriate, LL-HLS blocking reload and delta merging. Never put a cache-busting timestamp on every request by default.
4. Media pipeline: TS demux and AVC/AAC transmux to fragmented MP4; direct fMP4 initialization/media appends; timestamp rollover, discontinuity alignment, audio/video synchronization and MSE queue ownership.
5. Playback policy: live/VOD detection from media playlists, initial positioning, live hold-back, seek/DVR, buffer eviction, ABR estimation, rendition selection and recovery.
6. Subtitles: segmented WebVTT and timestamp mapping; IMSC1/TTML in the specified HLS carriage; rendition selection, timing, layout and explicit supported-profile limits. Existing MoQ bitmap and CEA-708 behavior must remain intact.
7. UI: LIVE only for live presentations, a VOD/DVR timeline, Auto/manual quality, language selection and protocol-neutral diagnostics.
8. Optional extensions: encryption/EME, content steering, timed metadata, interstitials and trick-play. These require their own capability and test matrix.

## Validation gates

Use generated redistributable media and deterministic local HTTP fixtures. Verify TS and fMP4 VOD, live sliding windows, event-to-ended transitions, seeking, range responses, alternate audio, subtitles and A/V timestamp continuity. Simulate loss, retries, discontinuities, stream restarts, rendition switches and teardown during requests. LL-HLS tests must observe actual blocking/delta/part requests and playback, not merely parser output.

Keep conformance results separate from parser support. Explicitly reject unsupported required features. Never claim full TTML, encryption or protocol-version coverage from one successful stream.

## Implementation ownership

A third-party engine adapter and an independently implemented engine are different deliverables. The selected direction is an independently implemented HLS engine. Any reused source must retain its license and attribution. An independent engine should derive behavior from the specifications and validate interoperability against other players without presenting their implementation as original work.

## Resilience delivery status

0.8.0-alpha.1 starts stages 1–2: deterministic HTTP faults, bounded resource recovery and declared-gap scheduling. The fault server can run locally in CI or on a separate HTTP host. This delivery does not complete the overall plan.

Next: stale-playlist detection, live-window catch-up and encoder restart/timeline recovery, including independent audio; then broaden PSI/PES and access-unit handling before the ABR, LL-HLS, subtitle and protection stages. Each change must add a reproduction fixture and verify cancellation, seeking and existing playback before publication.

0.9.0-alpha.1 extends recovery with stale publisher detection, missed-window/encoder timeline restarts, pause preservation and coordinated independent audio. It starts media-parser hardening with complete PSI section/table assembly and CRC validation. PES/access-unit boundaries, advanced ABR, LL-HLS, further captions and protection/extensions remain active work.

0.10.0-alpha.1 adds access-unit assembly across PES boundaries and constant-cadence multi-picture timing with exact packet-time/frame-hash checks, including B pictures and POC wrap. The next major delivery targets emergency ABR recovery and temporary rendition quarantine, followed by LL-HLS scheduling.

0.11.0-alpha.1 adds request-progress-based emergency downshifts and failed-rendition quarantine. Tests inject delayed first bytes, throttled bodies and HTTP 503 for Fetch/XHR, checking continued playback, cancellation and exclusion from subsequent automatic choices. LL-HLS is the next stage.

0.12.0-alpha.1 adds the first LL-HLS fMP4 delivery implementation and an isolated build/test output directory. Continue with subtitle carriage/rendering, protection/extensions and broader LL-HLS interoperability; the overall plan is still active.

0.13.0-alpha.1 adds original TTML/IMSC text and wvtt sample handling, layout/timing tests, encrypted text and WebVTT styling/clock improvements. Continue with CEA carriage/708 and remaining text-profile details, then protection/extensions and stabilization.

0.14.0-alpha.1 adds ATSC SEI carriage and field-2 CEA-608 decoding. Original CEA-708 decoding remains the next caption target; protection/extensions and stabilization remain active.

0.15.0-alpha.1 adds original CEA-708 SEI services, P16 and window rendering, plus avc3 parameter-set preservation. Remaining caption work includes c708/CDP and further layout/attribute validation; protection/extensions remain active.

0.16.0-alpha.1 adds c708/CDP and whole-resource encryption hardening (map key scope, rotation, key alternatives/session preloads, AES-256-GCM). Continue with sample encryption/EME, protocol extensions and stabilization.

0.17.0-alpha.1 adds SAMPLE-AES TS AVC/AAC, verified byte-for-byte and through browser playback. Continue with fMP4 sample encryption/EME, remaining protocol extensions and stabilization.

0.18.0-alpha.1 adds CENC/CBCS fMP4 through EME with ClearKey validation and automatic identity-key delivery. Continue with protected key/rendition rotation, remaining media/protocol extensions and stabilization; commercial CDM certification remains distinct from ClearKey coverage.

0.19.0-alpha.1 adds packed AAC and ID3/emsg metadata delivery with browser-engine coverage. Continue with remaining packed codecs, protocol extensions, expanded interoperability and stabilization.

0.20.0-alpha.1 adds packed MP3 with raw-MPEG/fMP4 browser capability selection and independent decoding checks. Continue with Dolby audio framing/encryption, protocol extensions and stabilization.

0.21.0-alpha.1 adds AC-3 TS/packed and AC-3/E-AC-3 fMP4 with browser capability validation. Continue with E-AC-3 framing, protocol extensions and stabilization.

0.22.0-alpha.1 adds single-substream E-AC-3 TS/packed and sample encryption. Continue with extended LL-HLS preloads, steering/interstitials and stabilization.

0.23.0-alpha.1 extends LL-HLS with growing-response ranges, MAP preloads and encrypted-part validation. Continue with content steering, interstitials/trick-play, remaining text profiles and stabilization.

0.24.0-alpha.1 adds content steering with matching pathway inventories, clones and recovery. Continue with interstitials/trick-play, remaining media/text profiles and stabilization, including the intermittent WebKit CI startup failure.

0.25.0-alpha.1 adds date-range metadata and playback cues plus v2 delta updates. Continue with interstitial asset playback, trick-play and remaining validation/profile gaps.
