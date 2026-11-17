// Remote test media remains hosted by its publisher; do not redistribute it as fixtures.
export const hlsExamples = [
  {
    id: 'apple-dv-atmos',
    name: 'Apple Dolby sample · compatible video / AAC / WebVTT',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/adv_dv_atmos/main.m3u8',
    reference: 'https://developer.apple.com/streaming/examples/',
  },
  {
    id: 'apple-av1',
    name: 'Apple AV1 · 10-bit / separate audio / WebVTT',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/av1-sample/av1-sample.m3u8',
    reference: 'https://developer.apple.com/streaming/examples/',
  },
  {
    id: 'apple-bipbop',
    name: 'Apple BipBop · fMP4 / separate audio / WebVTT',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
    reference: 'https://developer.apple.com/streaming/examples/',
  },
  {
    id: 'mux-bbb',
    name: 'Mux Big Buck Bunny · MPEG-TS / multiple qualities',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    reference: 'https://test-streams.mux.dev/',
  },
  {
    id: 'mux-bbb-480',
    name: 'Mux Big Buck Bunny · 480p',
    url: 'https://test-streams.mux.dev/x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8',
    reference: 'https://test-streams.mux.dev/',
  },
  {
    id: 'mux-arte',
    name: 'Mux ARTE China · multiple qualities',
    url: 'https://test-streams.mux.dev/test_001/stream.m3u8',
    reference: 'https://test-streams.mux.dev/',
  },
  {
    id: 'mux-ad-event',
    name: 'Mux ad insertion · AES-128 / discontinuities',
    url: 'https://test-streams.mux.dev/dai-discontinuity-deltatre/manifest.m3u8',
    reference: 'https://test-streams.mux.dev/',
  },
  {
    id: 'mux-issue666',
    name: 'Mux issue 666 · MPEG-TS byte ranges',
    url: 'https://test-streams.mux.dev/issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8',
    reference: 'https://test-streams.mux.dev/',
  },
  {
    id: 'mux-pts-shift',
    name: 'Mux DK Turntable · shifted timestamps',
    url: 'https://test-streams.mux.dev/pts_shift/master.m3u8',
    reference: 'https://test-streams.mux.dev/',
  },
  {
    id: 'unified-tos',
    name: 'Unified Tears of Steel · legacy AVC / five qualities',
    url: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.mp4/.m3u8',
    reference: 'https://demo.unified-streaming.com/',
  },
];
