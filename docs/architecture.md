# Architecture

The application supplies a source to `PlayerCore`. Its engine registry maps a protocol name to a factory. The core releases the previous engine before initializing a replacement, forwards events, and destroys subscriptions through the engine lifecycle. Only one engine owns the video element and MediaSource at a time.

`ThePlayer` registers the MoQ engine by default. Import the separate `core.js` bundle to avoid the MoQ dependency entirely when supplying other engines. Unknown protocols fail explicitly, without stopping a currently loaded source.

## Engine contract

The `PlaybackEngine` TypeScript interface in `src/core/player.ts` defines initialization, teardown, playback, track selection and observable state. Engines own transport-specific retries, buffering and media ingestion. The contract is an initial extension API: some catalog/diagnostic payloads retain the current MoQ shape and need normalization when adding a second engine.

Events forwarded by the core:

| Event             | Detail                                           |
| ----------------- | ------------------------------------------------ |
| `statechange`     | State string                                     |
| `catalog`         | Media catalog                                    |
| `error`           | Error object                                     |
| `autoplayblocked` | No payload                                       |
| `audiochange`     | Selected audio track                             |
| `subtitletracks`  | Available subtitle tracks                        |
| `subtitlechange`  | Selected track, or null for Off                  |
| `caption`         | `{ track, cue }` for the selected subtitle track |
| `captionwarning`  | Recoverable caption error                        |

Bitmap and CEA-708 cues share the media timestamp domain. `SubtitleRenderer` consumes caption events and owns canvas drawing, bitmap decoding and displayed-cue counters. Selection invalidates pending bitmap decodes. Destroying or reattaching the renderer clears listeners and its animation loop.

## Adding HLS or DASH

Implement a separate engine, then register its factory with `PlayerCore` or the third constructor argument to `ThePlayer`. Keep manifest/network libraries inside that engine. Prefer optional entry points or dynamic imports so MoQ-only users do not download HLS/DASH dependencies.

Before exposing the engine, normalize its audio/subtitle tracks and diagnostics, translate text cues to the common subtitle model, and test source replacement and teardown. Its buffer/ABR policy must be independent of MoQ's group-cache policy. A Shaka-based engine without Shaka UI is a candidate, not a bundled dependency today.

## Demo boundary

Directory discovery, reconnecting to a changed channel namespace, source inputs and integration examples belong to the demo. Library playback requires only an explicit source, with no administration API calls. The present controls retain a DOM contract with the demo; extracting a fully self-contained UI component is a separate step.
