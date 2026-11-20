import { boxes, inspectInit, concat, videoSampleEntryBoxes } from './mp4';
import { fragmentMetadata, fragmentSamples } from './fragment-samples';
import type { PreparedSegment } from './media-lane';

const child = (data: Uint8Array, name: string) => {
  const box = boxes(data).find((b) => b.type === name);
  if (!box) throw new Error('Missing preview ' + name);
  return box.body;
};
/** Decoder configuration comes from the actual sample entry, never its playlist label. */
export function previewConfiguration(init: Uint8Array) {
  const tracks = inspectInit(init);
  if (tracks.length !== 1 || tracks[0].kind !== 'video' || tracks[0].encryption)
    throw new Error('I-frame previews need one unprotected video track');
  const track = child(child(init, 'moov'), 'trak');
  const stsd = child(
    child(child(child(track, 'mdia'), 'minf'), 'stbl'),
    'stsd',
  );
  const entry = boxes(stsd.subarray(8))[0];
  const width = entry.body[24] * 256 + entry.body[25],
    height = entry.body[26] * 256 + entry.body[27];
  if (!width || !height || width * height > 16777216)
    throw new Error('Preview exceeds pixel limit');
  const name = entry.type.startsWith('avc')
    ? 'avcC'
    : ['hvc1', 'hev1'].includes(entry.type)
      ? 'hvcC'
      : entry.type === 'av01'
        ? 'av1C'
        : '';
  if (!name) throw new Error('Unsupported preview codec');
  const description = videoSampleEntryBoxes(entry.body).find(
    (box) => box.type === name,
  )?.body;
  if (!description) throw new Error('Missing preview ' + name);
  return {
    config: {
      codec: tracks[0].codec,
      codedWidth: width,
      codedHeight: height,
      ...(name !== 'av1C'
        ? { description: description.slice() as BufferSource }
        : {}),
    } as VideoDecoderConfig,
    av1Header: name === 'av1C' ? description.slice(4) : undefined,
  };
}
/** Locate a sequence header in AV1 low-overhead OBUs, rejecting truncated lengths. */
export function av1HasSequence(data: Uint8Array) {
  for (let at = 0; at < data.length; ) {
    const header = data[at++],
      type = (header >>> 3) & 15;
    if (header & 0x81) throw new Error('Invalid AV1 OBU header');
    if (header & 4) {
      if (at >= data.length) throw new Error('Truncated AV1 OBU extension');
      at++;
    }
    if (!(header & 2)) throw new Error('Preview AV1 OBUs need size fields');
    let size = 0,
      done = false;
    for (let n = 0; n < 8; n++) {
      if (at >= data.length) throw new Error('Truncated AV1 OBU size');
      const byte = data[at++];
      size += (byte & 127) * 2 ** (n * 7);
      if (!(byte & 128)) {
        done = true;
        break;
      }
    }
    if (!done || !Number.isSafeInteger(size) || at + size > data.length)
      throw new Error('Invalid AV1 OBU size');
    if (type === 1) return true;
    at += size;
  }
  return false;
}
export async function decodePreview(
  prepared: PreparedSegment,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (typeof VideoDecoder === 'undefined')
    throw new Error('I-frame previews require WebCodecs');
  const { config, av1Header } = previewConfiguration(prepared.init);
  let supported = await VideoDecoder.isConfigSupported(config);
  // An isolated AVC picture uses the parameter sets in its avcC record.
  // Some WebCodecs implementations expose avc1 but omit the avc3 alias.
  if (!supported.supported && config.codec.startsWith('avc3.')) {
    config.codec = config.codec.replace('avc3.', 'avc1.');
    supported = await VideoDecoder.isConfigSupported(config);
  }
  if (!supported.supported)
    throw new Error('Unsupported preview decoder ' + config.codec);
  const samples = fragmentSamples(
    prepared.data,
    fragmentMetadata(prepared.init),
    prepared.resourceOffset ?? 0,
  );
  if (
    samples.length !== 1 ||
    !samples[0].track.video ||
    samples[0].flags & 0x10000
  )
    throw new Error(
      'I-frame segment must contain one independently decodable picture',
    );
  let data = samples[0].data;
  if (config.codec.startsWith('av01.') && !av1HasSequence(data)) {
    if (!av1Header?.length || !av1HasSequence(av1Header))
      throw new Error('AV1 preview has no sequence header');
    data = concat(av1Header, data);
  }
  let frame: VideoFrame | undefined, reject!: (error: unknown) => void;
  const failure = new Promise<never>((_, bad) => {
    reject = bad;
  });
  void failure.catch(() => {});
  const decoder = new VideoDecoder({
    output: (output) => {
      if (frame) output.close();
      else frame = output;
    },
    error: reject,
  });
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => reject(new Error('Preview decoder timed out')),
    5000,
  );
  try {
    signal.throwIfAborted();
    decoder.configure(config);
    decoder.decode(
      new EncodedVideoChunk({
        type: 'key',
        timestamp: 0,
        data: data as BufferSource,
      }),
    );
    await Promise.race([decoder.flush(), failure]);
    signal.throwIfAborted();
    if (!frame) throw new Error('Preview decoder returned no frame');
    const output = frame as VideoFrame;
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(320, output.displayWidth);
    canvas.height = Math.max(
      1,
      Math.round((canvas.width * output.displayHeight) / output.displayWidth),
    );
    canvas
      .getContext('2d')!
      .drawImage(output, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Preview encoding failed'))),
        'image/jpeg',
        0.9,
      ),
    );
    signal.throwIfAborted();
    return { blob, width: canvas.width, height: canvas.height };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    if (decoder.state !== 'closed') decoder.close();
    (frame as VideoFrame | undefined)?.close();
  }
}
