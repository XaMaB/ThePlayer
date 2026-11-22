# Release versions

## 1.8.2

- Restore main-video scrubbing while dragging the VOD timeline, enabled by default. Integrators can select release-only seeking with `scrubbing: false` in `mountControls`.
- Coalesce drag updates, wait for unfinished seeks, and commit the exact destination on release. Cancel pending updates on gesture cancellation, source load and teardown.
- Preserve the destination-time bubble, thumbnails, keyboard seeking and the existing playing/paused state.

## 1.8.1

- Switch DASH audio near the playhead instead of waiting for queued audio to drain. Prepare the target media before replacing buffered audio, including paused playback and the final segment.
- Serialize exact BigInt DASH metadata as strings in the demo details panel without changing the engine model.
- Add decoded-audio, pause, end-of-stream and rewind regressions for language switching.

## 1.8.0

- MoQ CEA-708 now uses the original MP4/SEI and caption decoding core shared with HLS/DASH, including AVC/HEVC extraction and configurable P16 encodings.
- Preserve caption service selection, window geometry and absolute media timestamps; retract cancelled delayed displays and clear stale cues after a media-clock restart.
- Remove the obsolete caption dependency and its vendored files and notices. Other third-party notices remain unchanged.
- Add decoder and cross-browser canvas regressions for the MoQ caption adapter.

## 1.7.2

- Show an immediate floating destination time above the VOD seek bar during hover, pointer dragging and keyboard adjustment, even without thumbnails. Keep it inside the player at both edges and preserve the time when thumbnail loading fails.
- Keep the dragged value stable while playback advances and commit pointer seeks once on release; cancelled gestures leave playback unchanged. Use tabular time labels with hours for long videos.

## 1.7.1

- Accept the QuickTime four-byte zero terminator in video sample descriptions, including Apple HDR10+ HLS initialization segments. Keep ordinary MP4 boxes and malformed sample descriptions strict.
- Remove this optional terminator from HLS initialization data before MediaSource ingestion for Chromium compatibility, preserving codec configuration and media fragments.
- Share the corrected parsing across playback, caption metadata and I-frame previews. Add deterministic parsing, quality-switch and seek regressions.

## 1.7.0

- Add capability-based iPhone native-video fullscreen fallback, delayed-readiness button updates, prefixed Safari support and native exit-state tracking. Document system-control/overlay limitations.

- Add a configurable delayed buffering indicator with flowing chevrons, prolonged-wait text, reduced-motion support and MoQ rebuffer-state integration.
- Animate the skip-button triangles in the seek direction for pointer and keyboard input, with restartable waves and an opt-out.
- Document integration options and test real network starvation, recovery, pause, teardown and seek feedback in Chromium and WebKit.

## 1.6.2

- Avoid an unnecessary sub-frame startup seek when DASH playback is already within 50 ms of its intended starting position, including small audio/video timestamp offsets. This prevents flushing a decoder during its initial preroll; real start offsets and live positioning still seek normally.
- Isolate DASH browser scenarios and bound subtitle-test execution with stage diagnostics. Add regressions for natural VOD startup without a seek and explicit start-time positioning.

## 1.6.1

- Reduce the default controls idle timeout to 1500 ms. Explicit `autoHideDelayMs` overrides and 0 (always visible) remain supported.

## 1.6.0

- Add configurable toolbar/center layouts and grouped optional settings without expanding the main playback bar.
- Add VOD speed, subtitle appearance/reset, application/native chapters, an application-owned playback queue, and PNG download/clipboard helpers with DRM/CORS guards.
- Add native remote playback discovery/picker support and an explicit Google Cast sender adapter with receiver URL configuration, Play/Pause and disconnect. Hardware/provider acceptance tests remain integration-specific.
- Add the complete controls integration guide, a public-example demo queue and opt-in Cast initialization. Document bitmap/native caption limits, live/ad restrictions, ownership and cleanup.

## 1.5.2

- Replace the circular seek arrows with mirrored double-triangle icons and an embedded `10s` label. Use wider, rounded skip buttons with responsive sizing.

## 1.5.1

- Refresh PiP availability when decoded dimensions arrive after `loadedmetadata` (resize, loadeddata, canplay, play and playing). Prevent a disabled button from remaining stale during MSE/WebKit playback.
- Add Chromium/WebKit regressions for delayed video dimensions and source reset.

## 1.5.0

- Add an adaptive Picture-in-Picture module and shared control button for MoQ, HLS and DASH: Document PiP, standard video PiP and WebKit presentation-mode fallback.
- Add configurable browser-driven Auto PiP with page-level Media Session ownership, manual toggling and safe teardown/DOM restoration.
- Keep controls, canvas captions and TTML/CEA-708 frame scheduling attached to the active PiP document. Native video PiP retains browser-owned rendering limitations.
- Add real Chromium PiP playback checks and deterministic fallback/lifecycle checks in Chromium and WebKit. Document API options, integration requirements and browser-controlled automatic-entry limits.

## 1.4.1

- Refresh the demo with graphite surfaces and blue-violet accents, including player controls and the demo logo.
- Add HLS/DASH DRM test fields for key system, binary license endpoint, request headers, cookies, timeout, base64 server certificate, robustness and local Clear Key keys.
- Keep DRM credentials out of generated integration examples; show an editable license callback instead. Settings are not persisted or placed in share URLs.
- Document provider-specific DRM limits and verify the demo form with encrypted playback and license error handling.

## 1.4.0

- Add HLS/DASH Auto startup selection (`lowest` / `highest`) and upgrade policy (`stepwise` / `direct`). Preserve existing defaults, manual quality precedence and bandwidth/buffer safeguards.
- Expose the two settings in the demo, embed URL parameters, integration snippets and quality diagnostics.
- Recover a buffered WebKit startup seek once when it remains pending on slow delivery; defer automatic DASH switches until seeking completes.
- Add policy unit tests and three-profile Fetch/XHR browser checks for high startup, direct low-to-high upgrades, manual overrides and slow-link downshifts.

## 1.3.2

- Keep controls visible after touch/pen release. Pointer exit follows the idle timeout, including mouse input. Restart the timer on release and keep controls visible during held gestures.
- Add `mountControls` option `autoHideDelayMs`: 3000 ms by default, or 0 to disable automatic hiding.
- A touch on the video reveals controls without toggling playback; explicit play/pause buttons and mouse click behavior remain available.
- Add WebKit/Chromium touch regressions covering reveal, seeking, play/pause, idle hiding, held gestures and hybrid mouse input.

## 1.3.1

- Select ManagedMediaSource when ordinary MediaSource is unavailable, including all HLS/DASH/MoQ codec probes and MediaSource replacement paths.
- Enable inline playback and the remote-playback setting required by Safari; restore the original remote-playback policy on teardown.
- Enable the moq-dev WebSocket fallback and report the selected transport in MediaInfo. WebKit transport eligibility remains controlled by moq-dev; WebSocket requires a compatible relay and trusted TLS.
- Add real WebKit ManagedMediaSource playback, seek and teardown tests with ordinary MediaSource hidden, for DASH and HLS TS/fMP4 over Fetch/XHR. These tests do not replace physical iPhone validation.

## 1.3.0

- Promote the documented browser fMP4/CMAF DASH profile to Implemented; keep optional-profile and physical-device limits explicit in the support matrix.
- Add XLink, hierarchical SIDX, MPD validators/304, in-band producer time and CMAF transfer measurement that excludes inter-chunk production waits.
- Add Content Steering, JPEG thumbnails, alternate video views, audio language aliases/roles, CMCD v1/v2 request telemetry, raw CMSD and local QoE/Period events.
- Verify in-Period CENC/CBCS sample-group key rotation, AV1 in three browser engines and HEVC Main/AC-3/E-AC-3 in Linux WebKit; reject unavailable decoders explicitly.
- Expand deterministic/browser/public/soak coverage and refresh the README, demo, architecture, integration and verification documentation.

## CI follow-up to 1.2.0-alpha.1

- Pin GitHub runners to the validated Ubuntu 24.04 environment instead of the moving ubuntu-latest label.
- Bound DASH base-browser scenarios including evaluate/teardown calls, report the phase on timeout and print PASS only after page cleanup.
- Playback algorithms and the deployed player version are unchanged by this CI correction.

## 1.2.0-alpha.1

- Add DASH clear-video CEA-608/708 service discovery and rendering, including P16, positioning and seek history.
- Add declared BaseURL failover, bounded clock/topology restarts, EventStream/emsg metadata and MPD ProducerReferenceTime latency mapping.
- Add a single bounded retry for a decoded, buffered seek that remains pending after native TextTrack creation in WebKit; retain and deduplicate VTT history across Period seeks.
- Preserve subtitle timing across playback Period changes and PTO; filter unsupported required extensions at their declared scope.
- Expand browser regressions and update the README, architecture, DASH integration, support matrix and verification instructions. DASH remains a preview while the explicitly tracked acceptance and extension work is incomplete.

## 1.1.0-alpha.1

- Add DASH external/MP4 WebVTT and TTML, ClearKey CENC/CBCS and Period key rotation; verify public Widevine single/multikey media.
- Append Fetch CMAF chunks before complete responses, with XHR fallback and ServiceDescription latency control.
- Add transactional MPD Patch with full-MPD fallback, active representation removal and replacement Period recovery.

## 1.0.0-alpha.9

- Bound live MPD/segment recovery, keep independent lanes progressing and recover expired segments and DVR overruns.
- Preserve pause behavior and handle dynamic-to-static completion with deterministic browser fault tests.

## 1.0.0-alpha.8

- Introduce the original DASH engine, MPD addressing, fMP4 A/V, live/VOD, quality/audio selection and demo integration.
- Add deterministic browser fixtures and public interoperability checks.

## 1.0.0-alpha.6

- Align live video quality/angle switches without PROGRAM-DATE-TIME using a target media timestamp probe, rather than assuming matching media sequence numbers across renditions. Preserve the current media clock through the switch, including MPEG timestamp rollover adjustment.
- Keep probe decoder state separate from the playback lane and bridge active media through the switching boundary. This avoids timeline shifts and buffer holes when independently segmented renditions use different sequence spaces.
- Add browser coverage for overlapping-but-offset and completely disjoint rendition sequence numbers, repeated bidirectional switches, refreshed query parameters and continued playback.

## 1.0.0-alpha.5

- Wait for a delayed live rendition to publish a future switching boundary using a segment-duration-based time budget, replacing the previous two 250 ms retries.
- Continue refreshing and feeding the active media lanes while waiting. A target publication timeout rejects the switch while retaining the active rendition; destroying the player cancels the wait.
- Add browser coverage for seven-second publication delays over Fetch/XHR, timeout without playback interruption and teardown during a pending switch.

## 1.0.0-alpha.4

- Make detailed HLS live reset history opt-in through the source option `debug: true`. Default playback retains restart counts and reasons without collecting timeline comparisons.

## 1.0.0-alpha.3

- Fix false HLS timeline resets when an overlapping segment retains its sequence, discontinuity, origin/path, range and timing but receives renewed URL query parameters. Segment requests and caches still use the complete, newly advertised URL.
- Query renewal alone no longer counts as live media advancement, preserving stalled-publisher detection. Initialization metadata changes and changes to media path, duration or byte range remain subject to timeline checks.
- Exercise changing segment query parameters during upward/downward quality switches over Fetch/XHR, including continued playback, zero resets and use of refreshed URLs.

## 1.0.0-alpha.2

- Add a bounded, URL-redacted live reset history to distinguish sequence, resource, duration, date-time and initialization changes. Record the triggering comparison even when the restart limit stops playback. This is diagnostic instrumentation, not a change to recovery policy.
- Extend the live-window browser regression to quality switches in both directions and assert that valid switches do not restart the presentation.

## 1.0.0-alpha.1

- Begin the 1.x development series. DASH work is not included in this release.
- Fix HLS playback stopping after a live quality switch when the aligned rendition advertises segments before presentation time zero. Clamp the MSE live seekable range to zero while preserving internal media timestamps.
- Add a browser regression that switches from a three-segment window to an older, wider window and verifies continued playback, playlist refreshes and valid MSE ranges through Fetch and XHR.

## 0.45.0

- Mark HLS delivery as implemented with an explicit support matrix. Promotes the tested 0.45.0-rc.1 media implementation after full regression, cross-browser CI and a 30-minute live soak.
- Support declared HE-AAC v2 / Parametric Stereo in TS, fMP4 and packed audio.
- Preserve mono core configuration while signaling stereo output and the SBR sample clock.
- Add an original synthetic two-channel fixture, independent PCM equality checks and actual browser frequency/seek tests.
- Provide a real headless audio sink in CI and bounded frequency convergence checks after audio-graph startup/resume.
- Make optional public-stream tests honor isolated candidate builds.

## 0.44.0-alpha.1

- Decode CEA-608 background opacity/color and black foreground attributes, preserving implicit spacing and PAC resets.
- Render scoped native cue styles when supported; use a feature-detected 32-column DOM renderer in Firefox.
- Verify actual caption rendering, background pixels, service selection, seeking, Off and teardown across browser engines.
- Neutralize caption-only MP4 payload boxes only after sample-table ownership checks, fixing an early unbuffered seek failure in WebKit without shifting A/V offsets.
- Avoid redundant MSE timestampOffset assignments during continuous fragment appends.
- Includes development milestone 0.43, which was not published separately.

- Allow steering transitions between muxed A/V and separate video/audio lanes by replacing incompatible MediaSource ownership.
- Fetch and validate both candidate playlists and initial media before detaching the working pipeline.
- Preserve timeline position, paused/playing state, playback rate and track selections; reuse prepared media during initialization.
- Reject failed preflight media without interrupting the old pathway; fail explicitly if a committed replacement cannot initialize.
- Add Fetch/XHR VOD, live, reverse, paused and failed-preflight browser scenarios.

## 0.42.0-alpha.1

- Render CEA-708 FULL horizontal justification using word spacing, preserving glyph width and nonbreaking spaces.
- Apply media-clock fade and directional wipe visibility effects, including interrupted transitions, pause and backward seek.
- Preserve words and pen attributes when wrapping in all four print directions; retain hyphens at legal breaks.
- Add decoded-command unit tests and cross-browser geometry/timing checks alongside TS/fMP4/CDP caption playback.
- Includes development milestones 0.40–0.41, which were not published separately.

- Add HLS VIDEO rendition groups, default/explicit angle selection and a Video angle section in the shared Quality menu.
- Preserve angle names across differently ordered quality groups and steering clones; expose videoTracks, selectedVideoTrack and selectVideoTrack.
- Verify decoded color changes, paused switches, URI-less defaults and explicit startup without downloading the other angle.
- Do not estimate playback advance while paused when choosing a rendition-switch boundary.
- Reload a temporarily stale live target playlist when no future independent switching boundary is available, with bounded attempts and cancellation.
- Add deterministic LL-HLS stale-audio-target regression coverage for a WebKit CI failure.

- Rebuild the quality ladder when a steering pathway adds or removes variants; preserve stable identity or select a conservative bitrate fallback.
- Update alternate audio/subtitle inventories, preserve matching language identity and fall back according to DEFAULT/AUTOSELECT rules when audio disappears.
- Preserve manual/Auto mode, remap quality history, clear obsolete pathway quarantine and reject queued selections against stale inventories.
- Exercise shrinking/growing ladders, language replacement, initial failure and return to a working pathway through actual playback.

## 0.39.0-alpha.1

- Route audio, subtitle and quality controls to the active interstitial asset and preserve primary selections on return.
- Make subtitle selection part of the shared standalone controls, including immediate engine-event updates and listener cleanup.
- Support AVC level-only rendition switches on MSE implementations without changeType; reject incompatible codec changes explicitly.
- Verify paused asset switches, displayed WebVTT cues and primary restoration over Fetch/XHR in Chromium, Firefox and WebKit.
- Includes development milestones 0.37–0.38, which were not published separately.

- Schedule bounded Appendix F interstitial preloads within future date ranges and reuse completed direct-playlist/asset-list responses.
- Discard removed/mismatched preloads, ignore ended playlists and fall back immediately when a speculative request is unfinished or fails.
- Distinguish initial live tune-in from ordinary cue delay when adding interstitial start-offset query parameters.
- Add deterministic scheduling/retention tests and browser timing, reuse, removal, failure and cancellation scenarios.

- Expose protocol-neutral primary timeline markers and render interstitial point/range annotations in the VOD seek bar.
- Respect timeline style and PRE/POST placement, clamp ranges and hide primary markers during inserted playback.
- Allow application-provided Skip labels keyed by X-SKIP-CONTROL-LABEL-ID, with safe text rendering and English defaults.

## 0.36.0-alpha.1

- Retire temporary DRM sessions only after all their known KIDs leave buffered/prepared media; preserve unknown and pending key dependencies.
- Release per-session listeners, abort outstanding license callbacks and allow reacquisition on rewind.
- Bound dynamically acquired identity keys alongside session retirement.
- Verify 80 distinct CENC KIDs over Fetch/XHR, backward reacquisition and cleanup; retain active/unknown-key sessions in unit tests.

- Initialize Widevine from HLS KEYFORMAT PSSH data even when MP4 initialization contains no PSSH.
- Validate bounded base64 input, PSSH v0/v1 framing, system IDs, KID tables and data lengths before handing initialization to the CDM.
- Public single/multi-key CBCS tests pass Fetch/XHR with normal media and with MP4 PSSH boxes neutralized.

- Ignore attributes undefined for I-frame declarations instead of failing primary playback.
- Preserve opaque DRM identifiers such as FairPlay skd URIs with a KID:IV suffix.
- Add opt-in public Widevine CBCS interoperability tests using Axinom media and license delivery.

- Exercise AES-128 and AES-256-GCM LL-HLS parts inside growing byte-range responses.
- Validate Fetch speculative-prefix reuse and XHR bounded-range fallback with actual decoded playback in Chromium, Firefox and WebKit.

- Read HTTP Age for Fetch/XHR responses and perform bounded LL-HLS CDN tune-in before starting from a cached media playlist.
- Request estimated current segment/part positions, reuse fresh responses and defer preload hints until tune-in finishes.
- Fall back after rejected/timed-out directives; ignore malformed Age and cap repeated stale-cache responses.
- Browser checks cover refreshed startup position, directive rejection and invalid headers; unit tests cover boundaries and non-refreshing caches.

- Preserve the configured MIME type when inheriting a SourceBuffer for a same-codec rendition switch. This avoids requiring `changeType` in WebKit for an unchanged codec.
- Independent LL-HLS video and alternate AAC audio fixtures with different part durations and sequence numbers.
- Exercise blocking reloads, rendition reports, language switching, delayed audio and audio-only HTTP faults over Fetch/XHR.

- TTML ruby base/annotation grouping, matched base/text containers and two-sided annotations.
- Ruby half-size inheritance, before/after placement and native ruby alignment; fallback delimiters stay hidden during normal ruby presentation.
- Browser geometry/timing tests and real stpp subtitle integration.
- Outside-line placement, ruby reserves and exact cross-platform typography remain limited.

- TTML discrete `set` style animations with media-relative timing, inheritance and overlapping changes.
- Remove/freeze behavior, repeat counts, referenced animations, sequential region changes and bounded compilation.
- Forward/backward seek tests with actual encrypted/clear stpp playback and computed style checks across browsers.
- Continuous `animate` and broader typography remain separate work.

- Original I-frame rendition parsing and on-demand WebCodecs seek previews, separate from ABR qualities.
- TS/fMP4 initialization and byte ranges, including inferred initialization prefixes and widened AES-128 CBC ranges.
- Bounded preview caching and decoder cleanup; synthetic decoded-color and independent CBC byte checks.
- Validate AVC/HEVC/AV1 preview capabilities, live alignment and malformed-preview isolation in Chromium, Firefox and WebKit.

## 0.27.0-alpha.1

- JPEG image playlists, tiled seek thumbnails and live program-date alignment.
- Bounded resource caching, byte ranges, identity-key encryption and malformed-image isolation.
- In-player hover previews and original color-grid browser fixtures.

## 0.26.0-alpha.1

- Original interstitial asset/list resolution and isolated VOD playback with primary timeline restoration.
- Resume offsets, playout limits, segment snapping, nested suppression and skip/jump handling.
- In-video Skip UI, session events and diagnostics.
- Restore the primary stream after an initial decoded picture, keep pumping while the resume seek completes, and order final-position seeking before EOS.
- All 32 generated interstitial scenarios pass in Chromium, Firefox and WebKit; Amsterdam HTTPS playback/restoration passes. Twenty repeated WebKit TS/XHR metadata starts pass locally; the earlier CI startup anomaly is not yet confirmed resolved in CI.

## 0.25.0-alpha.1

- EXT-X-DATERANGE merge/validation, END-ON-NEXT, SCTE-35 payload preservation and UTC date handling.
- Playback entry/exit and PRE/POST/ONCE cue events, plus metadata update/removal events.
- v2 delta date-range merge/removal and complete-reload fallback for missing removal information.
- Invalid date-range metadata warns without interrupting video.

## 0.24.0-alpha.1

- Original HLS content steering: priorities, TTL/reloads, pathway clones and URI overrides.
- Preserve matching ABR/manual quality and audio/subtitle languages across pathways.
- Backup pathway selection for initial playlist/media failures and later network faults.
- HTTP 410/429 behavior, malformed-manifest fallback, pathway diagnostics/events and deterministic browser tests.
- Capture detailed media-event traces for the intermittent WebKit metadata startup failure seen in CI; no claim that the cause is resolved.

## 0.23.0-alpha.1

- LL-HLS open-range preloads can deliver authoritative parts before the HTTP response ends.
- MAP preloads preserve initialization bytes across the map-before-first-part transition.
- XHR uses bounded-range fallback for incomplete streaming responses.
- Growing-response, map reuse and AES-128 partial-segment browser scenarios.

## 0.22.0-alpha.1

- E-AC-3 TS/packed framing and six-block MP4 sample assembly for one independent substream.
- SAMPLE-AES E-AC-3 CBC chaining across syncframes with per-audio-sample IV resets.
- Independent decoded hashes/clock checks, malformed framing tests and WebKit playback/seeks.
- Dependent or multiple E-AC-3 substreams are explicitly rejected in TS/packed delivery; direct fMP4 remains browser-decoded.

## 0.21.0-alpha.1

- Original AC-3 TS/packed framing and fMP4 remux, with SAMPLE-AES frame decryption.
- AC-3/E-AC-3 fMP4 sample entries and browser capability filtering.
- Independent decoded audio/sample-clock checks and WebKit playback/seek coverage; explicit unsupported-browser errors.
- E-AC-3 TS/packed framing and audio setup/priming remain follow-up work.

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

Each published release commit receives an immutable annotated Git tag `v<package version>`. Experimental releases use `-alpha.N`; a higher alpha number identifies a new published build. A tag identifies the exact source snapshot, including prerelease builds. Tags are not moved or reused.

Before publishing:

1. Update the version and lockfile together (`npm version <version> --no-git-tag-version`).
2. Run `npm run check` and the affected engine fixture/browser suites (`fixtures:hls` / `test:hls`, `fixtures:dash` / `test:dash`); run cross-engine regressions for shared primitives. Keep public-network and hardware-CDM results separate from deterministic CI.
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
