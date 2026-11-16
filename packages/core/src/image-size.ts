/**
 * Pixel size and type of an uploaded image from its header (PNG, JPEG, WebP), so the offline map
 * can be laid out without an image library. Returns null for anything else.
 */
export interface ImageInfo {
  type: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
}

export function imageInfo(buf: Uint8Array): ImageInfo | null {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  // PNG: signature, then the IHDR chunk with big-endian width/height.
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR')
    return { type: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };

  // JPEG: walk the segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof)
        return { type: 'image/jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }

  // WebP: RIFF container with a VP8 / VP8L / VP8X chunk.
  if (
    b.length >= 30 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8X')
      return {
        type: 'image/webp',
        width: 1 + b.readUIntLE(24, 3),
        height: 1 + b.readUIntLE(27, 3),
      };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return {
        type: 'image/webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    }
    if (chunk === 'VP8 ')
      return {
        type: 'image/webp',
        width: b.readUInt16LE(26) & 0x3fff,
        height: b.readUInt16LE(28) & 0x3fff,
      };
  }
  return null;
}
