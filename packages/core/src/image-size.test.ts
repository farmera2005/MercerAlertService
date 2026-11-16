import { describe, expect, it } from 'vitest';
import { imageInfo } from './image-size';

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

function jpeg(w: number, h: number): Buffer {
  // SOI, an APP0 segment, then SOF0 with height/width.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(17, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe('imageInfo', () => {
  it('reads PNG, JPEG and WebP dimensions', () => {
    expect(imageInfo(png(1600, 900))).toEqual({ type: 'image/png', width: 1600, height: 900 });
    expect(imageInfo(jpeg(1024, 768))).toEqual({ type: 'image/jpeg', width: 1024, height: 768 });
    expect(imageInfo(webpVp8x(2000, 1200))).toEqual({
      type: 'image/webp',
      width: 2000,
      height: 1200,
    });
  });

  it('rejects anything else', () => {
    expect(imageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageInfo(Buffer.alloc(10))).toBeNull();
  });
});
