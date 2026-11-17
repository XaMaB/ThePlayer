# Release versions

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
