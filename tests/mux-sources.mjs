// Publisher-owned media: keep URLs only; do not redistribute the recordings.
export const muxSources = [
  {
    id: 'mux-bbb',
    name: 'Big Buck Bunny — adaptive',
    path: 'x36xhzz/x36xhzz.m3u8',
  },
  {
    id: 'mux-bbb-480',
    name: 'Big Buck Bunny — 480p',
    path: 'x36xhzz/url_6/193039199_mp4_h264_aac_hq_7.m3u8',
  },
  { id: 'mux-arte', name: 'ARTE China — ABR', path: 'test_001/stream.m3u8' },
  {
    id: 'mux-ad-event',
    name: 'Ad insertion — EVENT / discontinuities',
    path: 'dai-discontinuity-deltatre/manifest.m3u8',
    boundary: 36.28,
  },
  {
    id: 'mux-issue666',
    name: 'Issue 666 — MPEG-TS byte ranges',
    path: 'issue666/playlists/cisq0gim60007xzvi505emlxx.m3u8',
  },
  {
    id: 'mux-sample-aes',
    name: 'SAMPLE-AES encryption',
    path: 'bbbAES/playlists/sample_aes/index.m3u8',
    limitation: 'SAMPLE-AES',
  },
  {
    id: 'mux-pts-shift',
    name: 'DK Turntable — shifted timestamps',
    path: 'pts_shift/master.m3u8',
  },
  {
    id: 'mux-imsc',
    name: 'Tears of Steel — IMSC captions',
    path: 'tos_ismc/main.m3u8',
    limitation: 'No supported AVC/AAC rendition',
  },
].map((source) => ({
  ...source,
  url: 'https://test-streams.mux.dev/' + source.path,
}));
