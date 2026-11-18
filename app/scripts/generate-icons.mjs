#!/usr/bin/env node
/**
 * Generates Athena's PWA icon set as raw PNGs — no image-library dependency,
 * since this sandbox can't be assumed to have network access to install one
 * mid-build. Draws the same glyph as src/components/brand-mark.ts (three
 * connected nodes — a minimal knowledge-graph mark) on the cobalt orb
 * gradient, rasterized by hand and encoded to PNG via Node's built-in zlib.
 *
 * Run with: node app/scripts/generate-icons.mjs
 * Outputs to app/public/icons/*.png, referenced by app/public/manifest.json
 * and the <link rel="apple-touch-icon"> / <link rel="icon"> tags in
 * app/index.html. Re-run this script (don't hand-edit the PNGs) if the glyph
 * or brand colors in tokens.css change.
 */

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "public", "icons");
mkdirSync(OUT_DIR, { recursive: true });

// ---------- Tiny PNG encoder ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- Drawing helpers ----------

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

// The Ask orb's gradient (tokens.css / .orb): sky -> cobalt -> deep cobalt,
// from oklch(0.72 0.13 238) / (0.56 0.2 262) / (0.42 0.19 266).
const SKY = hexToRgb("#46afec");
const COBALT = hexToRgb("#2c6be7");
const DEEP = hexToRgb("#1c3cb2");

function gradientAt(t) {
  const [a, b, k] = t < 0.5 ? [SKY, COBALT, t * 2] : [COBALT, DEEP, (t - 0.5) * 2];
  return [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
}

function drawIcon(size, { fullBleed = true, maskableSafe = false } = {}) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = size / 24; // glyph authored in a 24x24 box, matching brand-mark.ts

  // Node positions (same geometry as src/components/brand-mark.ts).
  const nodes = [
    { x: 12, y: 6.2, r: 2.4, a: 1 },
    { x: 6.2, y: 16.8, r: 2.4, a: 0.9 },
    { x: 17.8, y: 16.8, r: 2.4, a: 0.9 },
  ];
  const edges = [
    [nodes[0], nodes[1]],
    [nodes[0], nodes[2]],
    [nodes[1], nodes[2]],
  ];

  // Center + scale the glyph a touch smaller for the maskable safe zone.
  const glyphScale = maskableSafe ? scale * 0.78 : scale;
  const offset = maskableSafe ? (size - 24 * glyphScale) / 2 : (size - 24 * scale) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x / size + y / size) / 2; // diagonal, light top-left to deep bottom-right like the orb
      let [r, g, b] = gradientAt(t);

      // Glyph space coordinates
      const gx = (x - offset) / glyphScale;
      const gy = (y - offset) / glyphScale;

      // Edges (thin connecting lines)
      let edgeAlpha = 0;
      for (const [a, bNode] of edges) {
        const d = distToSegment(gx, gy, a.x, a.y, bNode.x, bNode.y);
        const halfWidth = 0.9;
        const cov = Math.max(0, Math.min(1, halfWidth - d + 0.5));
        edgeAlpha = Math.max(edgeAlpha, cov * 0.75);
      }

      // Nodes (filled circles, drawn over edges)
      let nodeAlpha = 0;
      let nodeHit = false;
      for (const n of nodes) {
        const d = Math.hypot(gx - n.x, gy - n.y);
        const cov = Math.max(0, Math.min(1, n.r - d + 0.5));
        if (cov > nodeAlpha) {
          nodeAlpha = cov * n.a;
          nodeHit = cov > 0;
        }
      }

      const whiteAlpha = Math.max(edgeAlpha * (nodeHit ? 0 : 1), nodeAlpha, edgeAlpha);
      const finalAlpha = Math.min(1, nodeHit ? nodeAlpha : edgeAlpha);

      r = mix(r, 255, finalAlpha);
      g = mix(g, 255, finalAlpha);
      b = mix(b, 255, finalAlpha);

      const idx = (y * size + x) * 4;
      buf[idx] = Math.round(r);
      buf[idx + 1] = Math.round(g);
      buf[idx + 2] = Math.round(b);
      buf[idx + 3] = 255; // fully opaque — safe for apple-touch-icon too
    }
  }

  return buf;
}

function writeIcon(name, size, opts) {
  const buf = drawIcon(size, opts);
  const png = encodePNG(size, size, buf);
  writeFileSync(join(OUT_DIR, name), png);
  console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
}

writeIcon("icon-192.png", 192);
writeIcon("icon-512.png", 512);
writeIcon("icon-512-maskable.png", 512, { maskableSafe: true });
writeIcon("apple-touch-icon-180.png", 180);
writeIcon("favicon-32.png", 32);
