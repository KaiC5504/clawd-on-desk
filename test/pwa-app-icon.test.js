"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Minimal PNG reader: enough to read the edge pixels of an 8-bit, non-interlaced
// truecolor/-alpha PNG. iOS renders a transparent border as a white frame around
// the home-screen icon, so the only way to prove "no frame" is to inspect the
// actual border pixels — a header check alone can't.
function decodePng(buf) {
  let p = 8; // skip the 8-byte signature
  let ihdr = null;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("ascii", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    p += 12 + len; // length(4) + type(4) + data + crc(4)
  }
  const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : ihdr.colorType === 0 ? 1 : 0;
  if (!channels || ihdr.bitDepth !== 8 || ihdr.interlace !== 0) {
    throw new Error("test decoder only supports 8-bit, non-interlaced RGB/RGBA/grey PNGs");
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const v = raw[pos++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let recon;
      switch (filter) {
        case 0: recon = v; break;
        case 1: recon = v + a; break;
        case 2: recon = v + b; break;
        case 3: recon = v + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          recon = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("unexpected PNG filter " + filter);
      }
      cur[x] = recon & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

function pixel(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return img.channels === 4
    ? [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]
    : [img.data[i], img.data[i + 1], img.data[i + 2], 255];
}

describe("pwa app icon — full-bleed, no transparent/white frame", () => {
  for (const size of [256, 512]) {
    it(`icon-${size}.png fills every edge with opaque artwork`, () => {
      const file = path.join(__dirname, "..", "pwa", "icons", `icon-${size}.png`);
      const img = decodePng(fs.readFileSync(file));
      const w = img.width, h = img.height;
      // Corners + edge midpoints. iOS masks the corners into its squircle, but a
      // transparent (or white) border anywhere along the edge produces the frame.
      const samples = [
        [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
        [(w / 2) | 0, 0], [(w / 2) | 0, h - 1], [0, (h / 2) | 0], [w - 1, (h / 2) | 0],
      ];
      for (const [x, y] of samples) {
        const [r, g, b, a] = pixel(img, x, y);
        assert.strictEqual(a, 255, `edge pixel (${x},${y}) must be opaque, not transparent padding`);
        const nearWhite = r > 235 && g > 235 && b > 235;
        assert.ok(!nearWhite, `edge pixel (${x},${y}) must be artwork, not a white frame (got ${r},${g},${b})`);
      }
    });
  }
});
