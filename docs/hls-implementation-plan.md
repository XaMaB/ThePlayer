# HLS implementation plan

Status: original experimental baseline, separate AAC audio and manual quality switching implemented. Auto ABR and default/automatic rendition selection are implemented. Version 0.5.0-alpha.1 adds HEVC Main/Main10 remux and standalone AAC audio-only TS/fMP4, with browser codec capability filtering. Version 0.6.0-alpha.1 adds AV1 Main 8/10-bit fMP4 and the Apple AV1 sample. LL-HLS and TTML remain subsequent stages. See [current support](hls-support.md) and [architecture research](hls-research.md). The stages below describe the full intended scope, not the capabilities of the baseline.

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
