/** Rebuild sizes while adding a QuickTime terminator to visual sample entries. */
export function withVideoTerminator(input, suffix = new Uint8Array(4)) {
  const chunks = [];
  for (let at = 0; at < input.length; ) {
    const size = new DataView(input.buffer, input.byteOffset + at, 4).getUint32(
      0,
    );
    if (size < 8 || at + size > input.length)
      throw new Error('Invalid fixture box');
    const type = String.fromCharCode(...input.subarray(at + 4, at + 8));
    let body = input.subarray(at + 8, at + size);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type))
      body = withVideoTerminator(body, suffix);
    else if (type === 'stsd')
      body = Uint8Array.from([
        ...body.subarray(0, 8),
        ...withVideoTerminator(body.subarray(8), suffix),
      ]);
    else if (['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'encv'].includes(type))
      body = Uint8Array.from([...body, ...suffix]);
    const box = new Uint8Array(8 + body.length);
    new DataView(box.buffer).setUint32(0, box.length);
    box.set(input.subarray(at + 4, at + 8), 4);
    box.set(body, 8);
    chunks.push(box);
    at += size;
  }
  const result = new Uint8Array(chunks.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    result.set(chunk, at);
    at += chunk.length;
  }
  return result;
}
