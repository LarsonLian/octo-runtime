import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([name, data])), result.length - 4);
  return result;
}

// Shape answers appear only in pixels; native requests contain no filenames or labels.
export function visualInputImages() {
  const size = 256;
  return [0, 1, 2].map(index => {
    const scanlines = Buffer.alloc(size * (1 + size * 3), 255);
    for (let y = 0; y < size; y++) {
      scanlines[y * (1 + size * 3)] = 0;
      for (let x = 0; x < size; x++) {
        const inside = index === 0
          ? (x - 128) ** 2 + (y - 128) ** 2 <= 72 ** 2
          : index === 1 ? x >= 56 && x < 200 && y >= 56 && y < 200
            : y >= 48 && y <= 208 && Math.abs(x - 128) <= (y - 48) / 2;
        if (!inside) continue;
        const offset = y * (1 + size * 3) + 1 + x * 3;
        const color = [[230, 30, 40], [25, 170, 60], [30, 70, 230]][index];
        for (let channel = 0; channel < 3; channel++) scanlines[offset + channel] = color[channel];
      }
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 2;
    const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0))]);
    return { type: "image", mimeType: "image/png", data: bytes.toString("base64"), byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}
