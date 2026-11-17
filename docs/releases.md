# Release versions

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
