const MAX_BYTES = 10 * 1024 * 1024, MAX_PIXELS = 24000000, EDGE = 1600;
function dimensions(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 24 && text(1, 3) === 'PNG' && bytes[0] === 137 && v.getUint32(4) === 0x0d0a1a0a && text(12, 4) === 'IHDR')
    return { width: v.getUint32(16), height: v.getUint32(20), mime: 'image/png' };
  if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const kind = text(12, 4);
    if (kind === 'VP8X') return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16), mime: 'image/webp' };
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff, mime: 'image/webp' };
    if (kind === 'VP8L' && bytes[20] === 0x2f) return { width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8), height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10), mime: 'image/webp' };
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = v.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8)
        return { width: v.getUint16(offset + 5), height: v.getUint16(offset + 3), mime: 'image/jpeg' };
      offset += length;
    }
  }
  throw new Error('Use a valid JPEG, PNG, or WebP photo. Convert HEIC and SVG files to JPEG or PNG first.');
}
// The native editor has an opaque origin, so it calls this decoder directly.
// Both entry points enforce identical limits before decoding any selected image.
export async function processPhotoFile(file, signal) {
  let bitmap;
  const check = () => { if (signal?.aborted) throw new DOMException('Photo processing cancelled.', 'AbortError'); };
  try {
    check();
    if (!(file instanceof Blob) || file.size < 24 || file.size > MAX_BYTES) throw new Error('Each photo must be a valid image no larger than 10 MiB.');
    if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Convert this image to JPEG, PNG, or WebP first. HEIC and SVG are not accepted.');
    const bytes = new Uint8Array(await file.arrayBuffer()), info = dimensions(bytes);
    if (file.type && file.type !== info.mime) throw new Error('The photo contents do not match its file type. Export it again as JPEG or PNG.');
    if (info.width < 1 || info.height < 1 || info.width * info.height > MAX_PIXELS) throw new Error('Photos must contain at most 24 megapixels. Resize this photo before adding it.');
    check();
    bitmap = await createImageBitmap(new Blob([bytes], { type: info.mime }), { imageOrientation: 'from-image' });
    check();
    if (bitmap.width * bitmap.height > MAX_PIXELS) throw new Error('The decoded photo exceeds 24 megapixels. Resize it first.');
    const ratio = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * ratio)), height = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff'; context.fillRect(0, 0, width, height); context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close(); bitmap = null;
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: .85 });
    check();
    if (blob.size > 4 * 1024 * 1024) throw new Error('The processed photo is too large. Choose a smaller photo.');
    return { blob, width, height };
  } finally { bitmap?.close(); }
}
