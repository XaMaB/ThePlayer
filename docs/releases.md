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
