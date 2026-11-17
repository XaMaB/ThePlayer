# Release versions

## 0.20.0-alpha.1

- Add packed MPEG-1/2/2.5 Layer III with CBR/VBR frame parsing, ID3 clocks, AES-128 and timestamp rollover.
- Select native MPEG audio MSE where supported, or remux MP3 into fMP4 for browsers such as Firefox.
- Normalize MP3 playlist codec aliases and filter variants using the available audio container capability.
- Verify every MP3 payload and all independently decoded audio hashes/timestamps; exercise playback and seeks in Chromium, Firefox and WebKit.

## 0.19.0-alpha.1

- Add packed ADTS AAC with mandatory ID3 timestamp anchors, interleaved ID3, timestamp rollover, AES-128 and SAMPLE-AES.
- Parse ID3 v2.3/v2.4 framing, private timestamps, text encodings and unsynchronization; retain unknown/encoded frames as bytes.
- Expose timed ID3 from MPEG-TS and ID3/generic emsg v0/v1 from fMP4 through metadata events with presentation timestamps.
- Report malformed optional metadata as warnings and preserve media playback and byte offsets.
- Add byte-exact audio checks, Chromium/Firefox/WebKit playback/seek tests and a CI browser matrix for packed audio and timed metadata.

## 0.18.0-alpha.1

- Recognize protected encv/enca sample entries and cenc/cbcs track defaults while preserving encrypted bytes for the CDM.
- Add temporary EME sessions with ClearKey, an abortable license callback, license timeouts, key-status errors and teardown cleanup.
- Load identity SAMPLE-AES/SAMPLE-AES-CTR fMP4 keys automatically through ClearKey when the browser supports the scheme; validate rotating KIDs and CBCS constant IVs.
- Generate original CENC/CBCS AVC/AAC fixtures; compare all decoded audio/video hashes and timestamps with FFmpeg, and exercise playback, seeks, license failures and cleanup through Fetch/XHR.
- Commercial key systems, FairPlay-specific handling and persistent/offline licenses are not validated by these ClearKey tests.

## 0.17.0-alpha.1

- Decrypt identity SAMPLE-AES AVC/AAC in MPEG-TS before transmuxing, including key rotation and explicit/sequence IVs.
- Preserve CBC block boundaries, AVC outer escaping and samples split across PES.
- Verify every decrypted elementary byte and remux output against the clear fixtures; test playback and seeking through Fetch/XHR.
- fMP4 cbcs, EME and encrypted AC-3/E-AC-3 remain separate work.

## 0.16.0-alpha.1

- Decode separate c708/ccdp tracks with CDP section, checksum, sequence and cadence validation.
- Bind initialization encryption to the key active at EXT-X-MAP, preserving it across media-key rotation and METHOD=NONE.
- Select supported identity keys among KEYFORMAT alternatives, validate key attributes and separate repeated key declarations in the key cache.
- Preload supported SESSION-KEY entries and reuse them for the first media/map decryption.
- Add AES-256-GCM whole-resource decryption with authentication checks and original positive/tampered fixtures for Fetch/XHR.

## 0.15.0-alpha.2

- Normalize the subtitle test server root before checking paths, fixing default dist/ serving in GitHub CI.
- Validate the default build directory as well as isolated build directories.

## 0.15.0-alpha.1

- Decode CEA-708 services from AVC/HEVC SEI using an original packet, command and window implementation.
- Render anchor coordinates, row/column geometry, justification, pen colors/styles, wrapping and scrolling with media-clock delays and bounded seek history.
- Decode P16 as Unicode BMP by default, with explicit per-service EUC-KR/GBK/Big5 options.
- Preserve AVC parameter sets in-band with avc3 so multiple PPS IDs can coexist in broadcast segments; recognize immediate intra recovery points and retain non-random-access segment continuity.
- Keep caption packets by source segment ownership when presentation timestamps cross a nominal segment boundary.
- Add deterministic service, P16, delay, checkpoint and browser geometry/selection/seek tests. Remaining caption limitations are documented in the support matrix.

## 0.14.0-alpha.1

- Extract ATSC caption packets from AVC/HEVC SEI in TS and fMP4 before MSE append.
- Decode independent field-1 and field-2 CEA-608 services (CC1–CC4), including `cdt2`, while skipping XDS data.
- Preserve caption history across seeking and expose only advertised or observed services.
- Add original AVC SEI fixtures verified independently by FFmpeg and browser selection/seek tests for Fetch and XHR. HEVC SEI parsing has unit coverage; full HEVC-caption playback remains a separate validation target.

## 0.13.0-alpha.1

- Extract stpp/TTML and wvtt samples with checked MP4 timing and byte bounds.
- Render positioned TTML text regions and timed spans, preserving styling and subtitle selection/seek behavior.
- Support AES-128 text media/init and separate text codec declarations from MSE audio/video checks.
- Add scoped WebVTT styles, region placement, line/position anchors, cue deduplication and timestamp-map rollover.
- Validate Fetch/XHR text playback, layout geometry, safe XML and encrypted subtitles; add an isolated HTTPS test-server option.

## 0.12.0-alpha.1

- Play LL-HLS fMP4 parts before their parent segments are complete, preserving dependent pictures and independent startup points.
- Follow blocking reload and delta directives with full-playlist recovery when history is missing and polling fallback on rejected/time-limited directives.
- Prefetch bounded hinted resources, cancel superseded hints, and use rendition reports for peer positions.
- Apply PART-HOLD-BACK to live positioning and expose part/preload/reload diagnostics.
- Add isolated `THEPLAYER_DIST` builds and deterministic Fetch/XHR LL-HLS browser scenarios.

## 0.11.0-alpha.1

- Cancel slow Auto-mode segment requests when a lower rendition offers a better completion time.
- Recover failed main-rendition resources through lower compatible qualities and temporarily quarantine failures.
- Keep per-resource cancellation separate from session/audio cancellation and expose recovery diagnostics.
- Validate delayed responses, throttled bodies and HTTP 503 through Fetch/XHR browser playback.

`package.json` is the authoritative SemVer version. `src/version.ts` exports it as `VERSION`; the shared controls show it beside ThePlayer in MediaInfo and the context menu. The build writes `dist/version.json` and adds the version to bundle banners. There is no separately edited UI version.

Each published release commit receives an immutable annotated Git tag `v<package version>`. Experimental releases use `-alpha.N`; a higher alpha number identifies a new published build. A tag identifies the exact source snapshot, even while the HLS PR remains a draft. Tags are not moved or reused.

Before publishing:

1. Update the version and lockfile together (`npm version <version> --no-git-tag-version`).
2. Run `npm run check`, `npm run fixtures:hls` and `npm run test:hls`.
3. Commit the verified source and release notes, then create an annotated matching tag.
4. Push the branch and that specific tag together. Deploy the build from that version.

## 0.5.0-alpha.1

- HEVC Main/Main10 TS remux and fMP4 hvc1/hev1 initialization; browser capability filtering.
- AAC audio-only TS/fMP4 playback, bitrate ladder and mixed-master media-mode selection.
- VOD position and pause preservation when changing video/audio mode.
- Shared API/UI/build version and matching annotated Git release tag.
- Independent FFmpeg decoding and browser regressions; HEVC browser playback remains dependent on a capable device.

## 0.6.0-alpha.1

- AV1 fMP4 (`av01`/`av1C`) initialization and browser capability filtering.
- Profile, level, tier, bit-depth and nclx color codec signaling; invalid configuration rejection.
- Main 8/10-bit browser playback, quality changes and seeking, with original media bytes preserved.
- Apple AV1 sample in the demo and optional public tests, with external audio and WebVTT.
- Synthetic AV1 fixtures and codec parser regression tests.

## 0.6.0-alpha.2

- Do not let ancillary fMP4 c608/c708 tracks block supported HLS video/audio.
- Neutralize caption track and fragment descriptors without changing media offsets; record skipped captions in diagnostics. This does not add CEA-608/708 rendering.
- Keep external WebVTT selection available; verify the Apple Dolby sample through compatible AVC/AAC variants.
- Replace the remaining MoQ-only placeholder and integration copy with ThePlayer branding and protocol-neutral instructions.

## 0.7.0-alpha.1

- Original CEA-608 field-1 decoder for HLS fMP4 `c608`/`cdat`, with selectable CC1/CC2.
- Pop-on, paint-on and roll-up memories, PAC placement, character sets, parity and foreground styling.
- Caption timeline checkpoints, bounded seek preroll and replacement at quality transitions.
- Native text-track rendering with source row/column anchors; external WebVTT remains selectable.
- Synthetic unit/browser regressions and actual Apple English CC1 playback. See the support matrix for unsupported carriage and styling features.

## 0.8.0-alpha.1

- Bounded HLS resource recovery beyond short retries, with typed transport/HTTP errors and cancellation-aware backoff.
- Fetch/XHR recovery diagnostics; terminal authentication and malformed-resource failures remain explicit.
- Skip playlist-declared GAP resources and cross adjacent known gaps only after playable media arrives.
- Reusable isolated HTTP fault server and browser recovery tests, also runnable against an external host.
- Encoder restarts, stale-playlist handling and full timeline repair remain future stages.

## 0.9.0-alpha.1

- Track live publisher advancement independently of HTTP reload success; bounded stale-publisher handling.
- Coordinated video/audio MediaSource restart after sequence reset, changed segment identity or lost live window; preserve pause and selections.
- Re-establish external audio clocks when aligned playlists use distinct raw timestamp origins.
- Assemble and CRC-check multi-packet/multi-section PAT/PMT tables; reject malformed descriptors.
- Deterministic live recovery scenarios and independently decoded expanded-PMT fixtures.

## 0.10.0-alpha.1

- Assemble AVC/HEVC access units across PES boundaries; continuation PES may omit timestamps.
- Detect AVC pictures without AUD and retain multi-slice grouping; read HEVC first-slice POC metadata.
- Infer supported constant-cadence multi-picture timing from PES/VUI and POC, preserving B-frame presentation order.
- Validate PES timestamp prefixes/markers and reject inconsistent AVC parameter sets within a segment.
- Compare exact timestamps and decoded frame hashes for split and 2/20-picture PES fixtures; add browser playback/seek scenarios.
