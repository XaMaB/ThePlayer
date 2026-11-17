# Caption decoder dependency

Pinned source: mux.js 6.3.0 (npm), Copyright Brightcove, Apache-2.0.
These two CJS files are locally modified copies. Other parser utilities come from
the exact npm dependency. LICENSE is retained and embedded in built modules.

Local changes:
- P16 operands are consumed atomically inside their service block. A zero high
  byte is one character; other pairs are UCS-2/Unicode code units by default, or
  use the explicitly configured service encoding (e.g. EUC-KR). Surrogates become
  U+FFFD. Incomplete operands cannot read into the next service block.
- Service parameter bounds, 128-byte packet bound, packet size/sequence checks.
- Live display snapshots include clears, avoiding a wait for the caption end.
- CaptionParser forwards service options; SEI lengths are bounded to their NAL.

References:
- https://github.com/videojs/mux.js/issues/446
- https://github.com/videojs/mux.js/pull/455
- https://ccextractor.org/public/gsoc/olegkisselef_cea_708/
- Fixture: https://mtoczko.github.io/hls-test-streams/test-cea708-p16/playlist.m3u8

Scope: AVC/H.264 SEI in origin-cmaf-v1. Snapshots preserve separate windows,
anchor coordinates/anchor point, row and column dimensions, justification and pen
size. SPL writes at the actual row/column instead of inserting a newline. The
canvas uses these attributes and scales with the contained video rectangle.
Precise font families, pen colors/styles, display transitions, non-horizontal
print/scroll directions and DLY scheduling remain unsupported. This is not complete
CEA-708 receiver conformance. HEVC/MPEG-2 and CEA-608 rendering are not enabled.
Transcoding that removes SEI requires an Origin extraction path before captions
reach this decoder.

Positioning references:
- https://shaka-project.github.io/shaka-player/docs/api/lib_cea_cea708_window.js.html
- https://github.com/androidx/media/blob/release/libraries/extractor/src/main/java/androidx/media3/extractor/text/cea/Cea708Decoder.java
