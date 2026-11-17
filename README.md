<p align="center">
  <img src="assets/brand/banner.svg" alt="ThePlayer — Live video. Your interface." width="100%" />
</p>

<p align="center">
  <a href="https://github.com/XaMaB/ThePlayer/actions/workflows/check.yml"><img src="https://github.com/XaMaB/ThePlayer/actions/workflows/check.yml/badge.svg" alt="Build and checks" /></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-61ffe0?labelColor=101521" alt="Apache-2.0 license" />
  <img src="https://img.shields.io/badge/engine-moq--dev-55c9ff?labelColor=101521" alt="moq-dev engine" />
</p>

# ThePlayer

**Live television deserves a player that understands broadcast.**

ThePlayer is a modular browser player for live television and on-demand video. It combines MoQ delivery, an original experimental HLS engine, multilingual audio, broadcast captions and shared playback controls.

[Protocols](#protocols) · [Codecs](#audio-and-video) · [Subtitles](#subtitles) · [HLS features](#hls-features) · [Quick start](#development) · [Integration](#library) · [Architecture](docs/architecture.md)

## What you get

- **MoQ live playback:** WebTransport delivery, cached startup and a four-second target reserve.
- **HLS live, VOD and EVENT playback:** TS/fMP4 segments, Auto ABR, manual quality selection and audio-only streams.
- **Multilingual audio and captions:** audio/CC menus, source-positioned broadcast captions and subtitle Off.
- **Shared controls:** current Auto quality, resolution badges, play/pause, ±10 s seeking, keyboard shortcuts, fullscreen and MediaInfo. LIVE appears only for live presentations.
- **Independent integration:** explicit source configuration, separate engine modules and no Origin/Relay dashboard dependency.

## Protocols

| Protocol              | Status                      | Implemented scope                                                                                         |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| MoQ over WebTransport | Implemented                 | moq-dev/moq, `moq-lite-06`, `origin-cmaf-v1` catalog/media profile; live playback                         |
| HLS over HTTP(S)      | Experimental implementation | Original engine; live, VOD and EVENT; MPEG-TS and fragmented MP4; Auto/manual quality                     |
| LL-HLS                | Not implemented             | Complete segments may play as ordinary HLS; no partial-segment playback, blocking reload or delta updates |
| MPEG-DASH             | Planned                     | No DASH engine ships yet                                                                                  |
| UDP/RTP multicast     | Origin input only           | The browser does not join multicast groups; use an Origin to ingest and publish media                     |

MoQ transport compatibility alone does not guarantee interoperability: the publisher and player must also agree on the catalog and media profile. HLS is a tested subset, not a claim of full support for every protocol version. See the [HLS support matrix](docs/hls-support.md).

## Audio and video

The player uses Media Source Extensions (MSE) and browser decoders. It does not transcode or bundle software video decoders.

| Codec / mode                 | HLS carriage                       | Status and limits                                                                                                                                                    |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AVC / H.264                  | MPEG-TS and fMP4                   | Implemented; browser playback tested                                                                                                                                 |
| HEVC / H.265 Main and Main10 | MPEG-TS and fMP4 (`hvc1` / `hev1`) | Remux/configuration implemented and independently decoded with FFmpeg; browser/OS HEVC decoder required; visual HEVC browser playback not validated on the test host |
| AV1 Main, 8/10-bit           | fMP4 (`av01`)                      | Browser playback, quality changes and seeking tested; no AV1 TS/WebM/raw OBU input                                                                                   |
| AAC-LC / declared HE-AAC v1  | MPEG-TS and fMP4                   | Implemented, including separate audio renditions; HE-AAC v2 is excluded                                                                                              |
| Audio-only AAC               | MPEG-TS and fMP4                   | Implemented; bitrate selection and Video / Audio only mode for compatible mixed masters                                                                              |
| Dolby audio / Atmos          | —                                  | Not implemented                                                                                                                                                      |
| Dolby Vision / HDR output    | —                                  | Dolby Vision and HDR display/tone mapping are not validated                                                                                                          |

The MoQ engine appends catalog-advertised fragmented MP4 to MSE. Its codec compatibility depends on the publisher's media profile and the browser; the HLS-specific demux/remux matrix above does not imply equivalent MoQ codec validation. MoQ audio switching replaces the audio subscription/buffer while retaining the video connection and timeline.

MoQ targets a four-second buffer reserve; HLS has its own segment-based buffer and ABR policy. Actual buffer health varies with delivery and GOP structure. Neither target is a guaranteed end-to-end latency. MoQ adaptive bitrate rendition switching is not implemented.

## Subtitles

| Format                     | MoQ                                | HLS                                                       | Rendering / implemented scope                                                                                                     |
| -------------------------- | ---------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| DVB subtitles              | Implemented with compatible Origin | Not implemented                                           | Origin decodes timestamped bitmap cues; canvas preserves placement                                                                |
| Teletext                   | Implemented with compatible Origin | Not implemented                                           | Origin-decoded bitmap cues, selectable by advertised language/track                                                               |
| CEA-708 / DTVCC            | Implemented subset                 | Not implemented                                           | Browser decoding from AVC SEI; service discovery, window anchors, alignment, explicit rows/columns and pen size                   |
| CEA-708 P16                | Implemented subset                 | Not implemented                                           | Two-byte operands, Cyrillic/Latin Extended handling and configurable service encoding                                             |
| CEA-608                    | Not exposed                        | Implemented subset: fMP4 `c608` / `cdat`, field-1 CC1/CC2 | Original decoder; pop-on, paint-on, 2–4-row roll-up, PAC position/indent, character sets, foreground colors, italic and underline |
| WebVTT                     | Not exposed                        | Implemented subset                                        | External segmented WebVTT renditions, timestamp mapping and basic cue placement using browser TextTracks                          |
| TTML / IMSC1               | Not implemented                    | Planned                                                   | No `stpp` support                                                                                                                 |
| WebVTT inside MP4 (`wvtt`) | Not implemented                    | Not implemented                                           | Separate from external WebVTT rendition support                                                                                   |

**CEA-608:** parity checks and duplicate-control suppression are implemented. Caption history supports seeking and quality transitions. Field-2 CC3/CC4, TS/SEI carriage, multiple `c608` tracks, background attributes, flashing and Text/XDS remain unsupported. Native browser typography means placement is not a pixel-exact broadcast rendering. A live join or seek with insufficient history can wait for the next complete caption update.

**CEA-708:** cues retain source window positions and synchronize to the media clock, including fullscreen letterboxing. P16 consumes both operands atomically: a zero high byte represents one character; other pairs use Unicode code-unit handling or a configured service encoding such as EUC-KR. Invalid surrogate values become replacement characters. Full typography/colors, vertical writing, display effects and delayed commands remain incomplete. See the [decoder notes](vendor/mux.js/README.md).

**WebVTT:** STYLE/REGION blocks and some cue settings are not rendered. DVB and teletext decoding belongs to the Origin; their availability here does not mean browser-side raw broadcast subtitle decoding.

The CC menu includes **Off**, language/service selection and DVB/TXT/CC badges. MediaInfo separates received events, including clears and refreshes, from displayed subtitles. See the [caption support details](docs/hls-support.md).

## HLS features

| Feature                                             | Status                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Media and multivariant playlists                    | Implemented; relative URLs and playlist variables                                        |
| Live / VOD / EVENT                                  | Implemented; sliding refresh, finite duration, seeking and EVENT-to-ended transitions    |
| Auto ABR / manual quality                           | Implemented for compatible renditions in the same audio/subtitle groups                  |
| Multilingual external audio                         | AAC renditions with independent buffers and selection                                    |
| DEFAULT / AUTOSELECT / FORCED                       | Used for supported rendition selection; explicit choices and subtitle Off take priority  |
| Network loading                                     | Fetch or XHR; abort, timeout, bounded recovery window and byte ranges                    |
| AES-128 encryption                                  | Identity keys, explicit/sequence IV and Web Crypto AES-CBC                               |
| Discontinuities                                     | Timestamp rebasing; arbitrary timeline repair is not supported                           |
| SAMPLE-AES / DRM / EME                              | Not implemented                                                                          |
| Content steering / interstitials / timed metadata   | Not implemented                                                                          |
| I-frame trick play / image playlists / packed audio | Not implemented                                                                          |
| Declared GAP segments                               | Skipped without requests; playback resumes at buffered media after the declared interval |
| Live timeline resets                                | Bounded coordinated media restart; paused state and track selection retained             |

The HLS engine is original code: it does not bundle or copy hls.js, Video.js/VHS or Shaka implementations. This does not mean the entire player has no dependencies: MoQ uses moq-dev, and the MoQ caption path includes a locally patched mux.js decoder with provenance and licensing. See [architecture](docs/architecture.md), [research](docs/hls-research.md) and [detailed limits](docs/hls-support.md).

## Development

Requires Node.js 24+, npm and Git. Playback requires Media Source Extensions and suitable browser codecs. MoQ additionally requires WebTransport in a secure context; HLS requires HTTP(S) access and suitable CORS headers.

```sh
git clone https://github.com/XaMaB/ThePlayer.git
cd ThePlayer
```

```sh
npm ci
npm run bootstrap
npm run build
npm start
```

Open `http://localhost:5173`. For HLS, select HLS and supply a playlist URL. For MoQ, supply a relay URL, namespace and, for a self-signed development relay, its certificate fingerprint. WebTransport requires a secure context: localhost or HTTPS. The demo has no dependency on the Origin or Relay administration applications.

The bootstrap checks out moq-dev at `caf6ebc05d0b56a5689af1df431dd13804aaa1a2` into `.cache/moq`. Builds verify this revision. `MOQ_SOURCE` may point to an existing checkout at that revision. Do not replace it with an arbitrary npm version: the protocol and JS API are version sensitive.

```sh
npm test
npm run typecheck
npm run format
npm run check
```

The package remains private to prevent accidental npm publication. This does not prevent publishing its source repository.

## HLS integration

Choose **HLS · experimental** in the demo and enter a playlist URL. The engine is our own implementation, with no hls.js, Video.js/VHS or Shaka runtime dependency. See [architecture research](docs/hls-research.md) and [tested coverage](docs/hls-support.md).

```js
const player = new ThePlayer(video);
await player.load({
  protocol: 'hls',
  url: 'https://media.example.com/master.m3u8',
});
```

Deploy the entire `dist` directory, including `chunks`; HLS is loaded on demand. LIVE appears only for live presentations; VOD has a seek bar and duration.

## Library

```js
import { ThePlayer, SubtitleRenderer } from './dist/player.js';

const player = new ThePlayer(video);
const subtitles = new SubtitleRenderer(video, canvas);
subtitles.attach(player);

await player.load({
  protocol: 'moq',
  relayUrl: 'https://relay.example.com:4434',
  namespace: 'live/channel-one',
  catalogTrack: 'catalog',
});

await player.selectAudioTrack('audio-track-name');
player.selectSubtitleTrack('subtitle-track-name');
player.selectSubtitleTrack(''); // Off

// When removing the player:
subtitles.destroy();
await player.destroy();
```

The application provides the video and overlay canvas; position the canvas absolutely over the video with `pointer-events: none`. Track names come from `audioTracks` and `subtitleTracks`, not display labels. Listen for `catalog` and `subtitletracks` to populate menus. Subtitle rendering is optional; the video engine does not require a canvas.

`new ThePlayer(video, source)` followed by `init()` is also supported. `MoqPlayer` remains a legacy low-level alias for `MoqEngine`; new integrations should use `ThePlayer`.

## Modules

- `src/core`: common source lifecycle, engine registry and public engine contract; no MoQ imports.
- `src/engines/moq`: WebTransport connection, catalog, subscriptions, MSE, audio switching and buffering.
- `src/engines/hls`: playlist/network handling, segment scheduling, ABR, TS/fMP4 processing, WebVTT and CEA-608.
- `src/subtitles`: cue history/counters, reusable canvas renderer and CEA-708 decoding/layout.
- `src/ui`: the current in-video controls. These still use the demo's documented DOM IDs; this is not yet a drop-in custom element.
- `demo`: source form, optional channel directory, embed page and styling.
- `scripts`: reproducible build and pinned upstream checkout.
- `tests`: unit and engine lifecycle tests, without live multicast requirements.
- `vendor/mux.js`: locally patched caption decoder with its license and patch provenance.

See [architecture](docs/architecture.md) for extension boundaries and events.

## Validation

The 0.7.0-alpha.1 release passed formatting, TypeScript/build checks, 64 unit tests, 21 deterministic HLS browser scenarios and controlled-throughput ABR/UI checks. Independent FFmpeg decoding verifies HEVC remuxing; the test host's Chromium lacks an HEVC decoder, so those browser cases verify explicit capability rejection.

The 0.8.0-alpha.1 update adds three unit tests (67 total) and 16 deterministic recovery browser cases across Fetch/XHR. The recovery suite also passed against a separate HTTP server in Amsterdam. It checks temporary errors, interrupted responses, timeouts, playlist failures, bounded permanent failures, cancellation and declared gaps.

Public-source checks include Apple's AV1 sample and real CEA-608 English CC1 captions from Apple's Dolby demo through compatible AVC/AAC renditions. A working fallback from a Dolby demo does not establish Dolby Vision/Atmos support. Public tests are optional and network-dependent; CI uses generated fixtures.

```sh
npm run fixtures:hls
npm run test:hls
# Optional public-source checks:
npm run test:hls:public
```

Browser autoplay policy may require muted startup or a user gesture. Codec availability, rendering and device performance still need validation on your target browsers. See [release notes](docs/releases.md) for version-specific coverage.

## Optional deployment configuration

`settings.json` is local and ignored by Git. The server defaults to localhost HTTP port 5173 when it is absent. For HTTPS deployment, configure `webHost`, `webPort`, `cert` and `key`. An optional `relayDirectoryUrl` and `relayTrustPem` enable the demo channel list. `MOQ_PLAYER_CONFIG` selects another configuration file.

`/embed.html?relay=...&namespace=...&hash=...` loads without directory polling. `/player.js` is the default library bundle; `/core.js` is the transport-independent core.

To prepare a clean source directory for a new repository:

```sh
npm run export -- /path/to/ThePlayer
```

The destination must not exist. This copies an explicit source/documentation allowlist and includes the CI workflow. It does not publish or create a remote repository.

Do not commit local configuration, TLS keys, `.cache`, `node_modules`, generated bundles, test recordings or operational channel lists. Build artifacts are generated from source.

## Contributing

Start with [the architecture](docs/architecture.md). Keep transport-specific buffering inside the engine, caption rendering inside the subtitle module, and directory discovery inside the demo. Run `npm run check` before opening a pull request.

For playback bugs, include browser/version, codec and catalog details, reproduction steps and relevant MediaInfo values. For caption bugs, include the subtitle format, service/language and a small redistributable fixture where possible. Remove credentials and private endpoint details from reports.

## Roadmap

- Extend the original HLS engine: LL-HLS, further ABR recovery and TTML/IMSC1.
- Extend HLS caption carriage beyond fMP4 CEA-608, including TS/SEI and CEA-708.
- Add a DASH engine behind the common lifecycle.
- Normalize track/diagnostic models across engines.
- Package the controls as a self-contained UI component.
- Extend caption conformance and fixture coverage.

## License

Application code is Apache-2.0. See `NOTICE`, `LICENSE-APACHE`, the included upstream notices and `vendor/mux.js/LICENSE` for bundled dependencies.

### Playback shortcuts

Space or K toggles play/pause; Left/Right seeks by ten seconds within the available timeline. The center controls offer the same actions. Live streams can seek only within their available DVR/buffer window. Shortcuts apply to the active player and leave text fields and menu selection keys alone. Unavailable audio/CC controls use an ordinary cursor, not a loading indicator.

## Release identification

Current prerelease: **0.10.0-alpha.1**. MediaInfo shows the same version exported as `VERSION` from `player.js`; builds also expose `version.json`. Published snapshots have matching annotated Git tags. See [release notes and versioning](docs/releases.md) and the [HLS support matrix](docs/hls-support.md) for verified capabilities and limitations.
