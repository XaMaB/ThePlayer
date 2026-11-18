# Original audio fixture

`he-aac-v2.aac` contains twelve seconds of generated stereo sine waves: 440 Hz left and 880 Hz right, encoded as 32 kbit/s HE-AAC v2 with a 48 kHz output rate. It contains no third-party recording. The media may be redistributed with ThePlayer under its Apache-2.0 license.

SHA-256: `465b9dfbc1631bae5bae89ed7d81bf3eb2b47dcfd1f64b6d9ad2fd8ce74fd3d6`.

The original generator is `../helpers/encode-he-aac-v2.c`. It uses the documented encoder API from FDK AAC v2.0.3. Build the full upstream FDK library separately, then link the generator against it; distribution builds that disable SBR/PS cannot generate this fixture. FDK implementation code and libraries are not included in ThePlayer or its browser bundles. No encoder is needed to run the tests against the checked-in fixture.

`node scripts/prepare-he-aac-fixtures.mjs` creates TS, fMP4 and packed HLS variants with FFmpeg and ThePlayer's original transmuxer. It independently decodes the ADTS source and remuxed MP4 with FFmpeg and requires byte-identical stereo PCM. Browser tests also check distinct channel frequencies and bidirectional seeking.

On headless Linux, Firefox needs a working audio sink to run its real-time Web Audio graph. CI starts PulseAudio with a null sink before frequency measurements (`pulseaudio --start --exit-idle-time=-1 --load=module-null-sink`). This is a test-host requirement, not a player dependency. A suspended graph must not count as a passed audio assertion.
