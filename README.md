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

ThePlayer brings multilingual audio, broadcast captions and live playback controls to a modular browser player. Build your own interface, embed the demo, or plug a new transport into the shared lifecycle.

[Quick start](#development) · [Subtitles](#subtitles) · [Integration](#library) · [Architecture](docs/architecture.md)

## What you get

- **Live over MoQ:** WebTransport delivery, cached startup and a four-second target reserve.
- **Audio language selection:** switch audio tracks while retaining the video timeline and connection.
- **Broadcast subtitles:** selectable DVB, teletext and in-band CEA-708 services, with a shared canvas renderer.
- **In-video controls:** matching quality/audio/CC menus, Auto/current-quality readout, center play/pause and ±10 s controls, LIVE indicator, fullscreen and a branded MediaInfo overlay.
- **An independent library:** explicit source configuration; no Origin/Relay dashboard dependency.
- **A modular foundation:** separate core, engines, subtitles, controls and demo.

## Protocols

| Protocol              | Status                | Notes                                                                                         |
| --------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| MoQ over WebTransport | Implemented           | moq-dev/moq, `moq-lite-06`, `origin-cmaf-v1` catalog/media profile                            |
| HLS                   | Experimental baseline | Original AVC/HEVC/AAC TS/fMP4 and AV1 fMP4 engine; [coverage and limits](docs/hls-support.md) |
| MPEG-DASH             | Planned               | Engine API is in place; no DASH engine ships yet                                              |

MoQ defines transport behavior; applications still need a matching catalog and media profile. An arbitrary MoQ relay or publisher is not automatically interoperable with this player.

The DVB, teletext and CEA-708 entries below describe the **MoQ pipeline**. HLS currently supports WebVTT only; see its [separate matrix](docs/hls-support.md).

## Subtitles

| Format             | Available today                  | Delivery and rendering                                                                       |
| ------------------ | -------------------------------- | -------------------------------------------------------------------------------------------- |
| DVB subtitles      | Yes, with a compatible Origin    | Origin-decoded, timestamped bitmap cues; browser canvas preserves their placement            |
| Teletext subtitles | Yes, with a compatible Origin    | Origin-decoded bitmap cues, selectable by the advertised track/language                      |
| CEA-708 / DTVCC    | Implemented subset               | Decoded in the browser from AVC/H.264 SEI; service discovery and selectable caption services |
| CEA-708 P16        | Yes                              | Two-byte operand handling, Cyrillic/Latin Extended support and configurable service encoding |
| WebVTT             | HLS baseline                     | Segmented text cues and basic browser placement                                              |
| TTML / IMSC        | Not implemented                  | Planned HLS text/manifest integration                                                        |
| CEA-608            | Not exposed as a supported track | No supported end-to-end selection/rendering API in this release                              |

**CEA-708 layout follows the source.** Window anchors, positioning, justification, explicit rows, column limits and pen size are retained. Captions are synchronized to the video's media clock, including fullscreen letterboxing.

P16 consumes both operands atomically. A zero high byte represents one character; other pairs use the decoder's Unicode code-unit handling or a configured service encoding, such as EUC-KR. Invalid surrogate values become replacement characters. See the [decoder notes](vendor/mux.js/README.md) and tests for the implemented behavior.

This is not a complete CEA-708 conformance implementation. Full typography/color handling, vertical writing, display effects and delayed commands remain incomplete. DVB and teletext support here does **not** mean the browser accepts raw MPEG-TS or joins a multicast group: decoding those subtitle formats belongs to the Origin.

The CC menu includes **Off**, language/service selection and DVB/TXT/CC badges. MediaInfo separates **received events** (including clears and refreshes) from **displayed subtitles**.

## Audio and video

HLS supports AVC, HEVC Main/Main10 and AAC in TS/fMP4, including audio-only streams, plus AV1 Main 8/10-bit in fMP4. HEVC and AV1 playback require browser/OS decoder support. Mixed masters expose Video / Audio only in the Quality menu. See the [HLS matrix](docs/hls-support.md) for tested formats and device-validation limits.

The MoQ engine appends fragmented MP4 to Media Source Extensions. Playback depends on browser support for the advertised codecs; the player does not transcode. Multilingual audio tracks come from the media catalog. Track switching replaces the audio subscription and buffer while keeping the video connection and timeline.

The current four-second reserve is a buffering policy, not a guaranteed end-to-end latency. Actual buffer health varies with fragment delivery and GOP structure. The MoQ engine does not implement DRM or adaptive bitrate rendition switching. The HLS engine has Auto ABR and manual quality selection.

A modular browser player for live video. The current engine uses **moq-dev/moq** over WebTransport and plays the `origin-cmaf-v1` media profile. An original experimental HLS engine now handles the tested baseline described in [HLS support](docs/hls-support.md). DASH remains planned.

## Development

Requires Node.js 24+, npm and Git. Use a browser with WebTransport and Media Source Extensions in a secure context.

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

Open `http://localhost:5173`. Supply a relay URL, namespace and, for a self-signed development relay, its certificate fingerprint. WebTransport requires a secure context: localhost or HTTPS. The demo has no dependency on the Origin or Relay administration applications.

The bootstrap checks out moq-dev at `caf6ebc05d0b56a5689af1df431dd13804aaa1a2` into `.cache/moq`. Builds verify this revision. `MOQ_SOURCE` may point to an existing checkout at that revision. Do not replace it with an arbitrary npm version: the protocol and JS API are version sensitive.

```sh
npm test
npm run typecheck
npm run format
npm run check
```

The package remains private to prevent accidental npm publication. This does not prevent publishing its source repository.

## HLS preview

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
- `src/subtitles`: cue history/counters, reusable canvas renderer and CEA-708 decoding/layout.
- `src/ui`: the current in-video controls. These still use the demo's documented DOM IDs; this is not yet a drop-in custom element.
- `demo`: source form, optional channel directory, embed page and styling.
- `scripts`: reproducible build and pinned upstream checkout.
- `tests`: unit and engine lifecycle tests, without live multicast requirements.
- `vendor/mux.js`: locally patched caption decoder with its license and patch provenance.

See [architecture](docs/architecture.md) for extension boundaries and events.

## Current support and limits

- MoQ uses `moq-lite-06` and this project's `origin-cmaf-v1` catalog. Generic MoQ transport compatibility alone does not guarantee compatible catalogs or media tracks.
- Video/audio must be supported by the browser's Media Source Extensions. MoQ audio switching retains the video connection and timeline; HLS supports external AAC audio renditions, Auto ABR and manual quality selection.
- Buffer policy targets a four-second reserve, with cached startup where available. Actual buffer health varies with fragment/GOP delivery; it is not a fixed end-to-end latency guarantee.
- DVB and teletext subtitles arrive as timed bitmap cues from the Origin. CEA-708 is decoded from AVC SEI, including P16 characters, per-window positioning, alignment and explicit row structure.
- CEA-708 is not a complete conformance implementation: all typography, colors, vertical writing, effects and delayed commands are not yet supported. See the vendor notes.
- Browser autoplay policies may require muted startup or a user gesture.
- HLS is experimental: no LL-HLS part playback, TTML or DRM yet. DASH remains planned.

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

- Extend the original HLS engine: LL-HLS, further ABR recovery and TTML.
- Add a DASH engine behind the common lifecycle.
- Normalize track/diagnostic models across engines.
- Package the controls as a self-contained UI component.
- Extend caption conformance and fixture coverage.

## License

Application code is Apache-2.0. See `NOTICE`, `LICENSE-APACHE`, the included upstream notices and `vendor/mux.js/LICENSE` for bundled dependencies.

### Playback shortcuts

Space or K toggles play/pause; Left/Right seeks by ten seconds within the available timeline. The center controls offer the same actions. Live streams can seek only within their available DVR/buffer window. Shortcuts apply to the active player and leave text fields and menu selection keys alone. Unavailable audio/CC controls use an ordinary cursor, not a loading indicator.

## Release identification

Current prerelease: **0.6.0-alpha.2**. MediaInfo shows the same version exported as `VERSION` from `player.js`; builds also expose `version.json`. Published snapshots have matching annotated Git tags. See [release notes and versioning](docs/releases.md) and the [HLS support matrix](docs/hls-support.md) for verified capabilities and limitations.
