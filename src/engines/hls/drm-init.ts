import type { Key } from './playlist';

const widevine = 'edef8ba979d64acea3c827dcd51d21ed';

/** HLS Widevine version-1 URI carriage contains a complete base64 PSSH box. */
export function playlistInitData(
  keys: Key[],
  keySystem: string,
): Uint8Array | undefined {
  if (keySystem !== 'com.widevine.alpha') return;
  const key = keys.find(
    (key) =>
      key.format.toLowerCase() ===
        'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' &&
      (key.versions ?? [1]).includes(1) &&
      ['SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(key.method),
  );
  if (!key) return;
  const uri = key.url ?? '';
  if (uri.length > 90000)
    throw new Error('DRM initialization URI exceeds limit');
  const match = /^data:[^,]*;base64,(.*)$/i.exec(uri);
  if (!match) throw new Error('Widevine HLS key requires base64 PSSH data');
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(decodeURIComponent(match[1])), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    throw new Error('Invalid DRM initialization base64');
  }
  if (!bytes.length || bytes.length > 65536)
    throw new Error('Invalid DRM initialization size');
  const view = new DataView(bytes.buffer);
  let position = 0,
    found = false;
  while (position < bytes.length) {
    if (position + 32 > bytes.length) throw new Error('Truncated PSSH box');
    const size = view.getUint32(position),
      end = position + size;
    if (
      size < 32 ||
      end > bytes.length ||
      view.getUint32(position + 4) !== 0x70737368
    )
      throw new Error('Invalid PSSH box');
    const version = bytes[position + 8];
    if (version > 1 || view.getUint32(position + 8) % 0x1000000 !== 0)
      throw new Error('Unsupported PSSH version or flags');
    const system = Array.from(
      bytes.subarray(position + 12, position + 28),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    let dataPosition = position + 28;
    if (version === 1) {
      const count = view.getUint32(dataPosition);
      dataPosition += 4 + count * 16;
    }
    if (
      dataPosition + 4 > end ||
      dataPosition + 4 + view.getUint32(dataPosition) !== end
    )
      throw new Error('Invalid PSSH data length');
    found ||= system === widevine;
    position = end;
  }
  if (!found) throw new Error('Widevine PSSH system ID is missing');
  return bytes;
}
