# MoQ CEA-708 captions

MoQ uses ThePlayer's original fragmented MP4 parser, AVC/HEVC SEI extractor and CEA-708 decoder. HLS and DASH share the same packet, service and timeline implementation. No separate caption decoding dependency is required.

## Configuration

Provide service metadata in the MoQ source or the Origin catalog. Source metadata takes precedence:

```js
await player.load({
  protocol: 'moq',
  relayUrl: 'https://relay.example.com',
  namespace: 'channels/example',
  captionServices: {
    SERVICE1: { language: 'bul', label: 'Bulgarian', encoding: 'unicode' },
    SERVICE2: { language: 'kor', label: 'Korean', encoding: 'euc-kr' },
  },
});
```

Service numbers range from 1 to 63. Services are discovered from received captions; metadata does not create an empty track. Without metadata the language is `und`, the label is `Service N`, and P16 uses `unicode`. Supported P16 encodings are `unicode`, `euc-kr`, `gbk` and `big5`. P16 operands are text bytes, including values that would be commands outside P16; truncated operands cannot consume another service's block.

Select a discovered service with `player.selectSubtitleTrack('cea708-1')`; pass `''` for Off. The existing CC menu provides the same selection. `player.subtitleHistory(name)` returns a bounded recent history, not an archive.

## Timing and display

The adapter reads sample presentation timestamps, including composition offsets, without rebasing the MoQ media clock. DTVCC packets can span samples and media objects. The shared core handles packet loss, service state, window definitions, P16, delay/cancel, reset, visibility and pen location. Duplicate media does not emit duplicate caption events. Each service keeps at most 200 display snapshots; packet replay also has a bounded window.

MoQ's canvas renderer preserves window anchors, relative coordinates, rows, columns, justification and pen size. It follows the video clock, letterboxing and configured caption appearance. Text is plain text, never HTML. The canvas currently uses uniform user-selected styling: per-cell broadcast colors/fonts, fade/wipe effects and direction-specific animation are not reproduced by this renderer. HLS/DASH's DOM caption renderer has richer styling; sharing the decoder does not make these renderers identical.

A new display replaces the previous one, including empty clear displays. MoQ display snapshots retain the existing 30-second safety expiry. The optional `replaceFrom` field on a `caption` event retracts queued snapshots from that media timestamp when a delayed display is cancelled or the media clock restarts. Custom renderers should discard queued cues at or after this value before adding the replacement cue. Normal events remain `{ track, cue }`.

Malformed caption fragments produce `captionwarning` without stopping media append. CEA-608 packets are not exposed as MoQ CEA-708 services. Existing Origin-provided DVB bitmap and teletext tracks retain their separate caption path.

## Regression coverage

`npm test` covers P16 encodings, split packets, extended services, composition offsets, duplicate objects, truncated input, packet loss, window geometry, delayed displays, clock restart and bounded history. `npm run test:moq:captions` exercises the adapter and canvas in Chromium, Firefox or WebKit (`MOQ_CAPTION_BROWSER`), with real fMP4 video playback, service switching, seeking, pause, replacement and Off. Generate media first with `npm run fixtures:hls`.

The deployment environment additionally has an isolated Origin/Relay publisher test using a real P16 fixture. It exercises transport, automatic track discovery, CC selection and canvas output without restarting production channels. Browser automation does not replace testing on physical Safari/iOS devices.
